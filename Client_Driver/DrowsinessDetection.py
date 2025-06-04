from flask import Flask, render_template, Response
import cv2
import dlib
import numpy as np
from scipy.spatial import distance
import time
import threading
import os
import collections
import socketio # Python Socket.IO Client
import logging

# --- Konfigurasi Awal & Path ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__)) # This will be Client_Driver directory
PROJECT_ROOT = os.path.dirname(BASE_DIR) # MONITORING-KANTUK directory

MODEL_PATH = os.path.join(BASE_DIR, "model", "shape_predictor_68_face_landmarks.dat")
TEMPLATE_FOLDER = os.path.join(BASE_DIR, "templates")
STATIC_FOLDER_DRIVER = os.path.join(BASE_DIR, "static") # For Driver.js

# Supervisor templates/static might be served from a different Flask app or use absolute paths if needed
# For this structure, Python Flask app serves only Driver related files.
# Supervisor HTML/JS will be simple static files opened directly or served by another simple server if needed.
# Or, the Node.js server could also serve static HTML files for the supervisor.

print(f"[*] Script base directory (Client_Driver): {BASE_DIR}")
print(f"[*] Project root: {PROJECT_ROOT}")
print(f"[*] Looking for Dlib model at: {MODEL_PATH}")
print(f"[*] Looking for HTML templates in: {TEMPLATE_FOLDER}")
print(f"[*] Static files for driver in: {STATIC_FOLDER_DRIVER}")


# --- Flask App Setup ---
app = Flask(__name__, template_folder=TEMPLATE_FOLDER, static_folder=STATIC_FOLDER_DRIVER)
app.config['SECRET_KEY'] = 'driver_flask_secret!'

# --- Socket.IO Client Setup (to connect to Node.js server) ---
sio = socketio.Client(logger=True, engineio_logger=True)
NODE_SERVER_URL = '192.168.112.150:3000' # URL of your Node.js server
DRIVER_ID = "driver_001" # Unique ID for this driver instance

# --- Sound Alarm ---
SOUND_ENABLED = False
ALARM_SOUND_PATH = os.path.join(PROJECT_ROOT, "assets", "sounds", "alarm.wav") # Adjust if your structure is different

try:
    import pyglet
    if os.path.exists(ALARM_SOUND_PATH):
        pyglet.options['audio'] = ('openal', 'pulse', 'directsound', 'silent') # Add more options if needed
        alarm_sound_player = pyglet.media.load(ALARM_SOUND_PATH, streaming=False)
        SOUND_ENABLED = True
        print(f"[*] pyglet loaded. Alarm sound enabled using: {ALARM_SOUND_PATH}")
        def play_alarm_sound_action():
            alarm_sound_player.play()
            print("ALARM! MENGANTUK TERDETEKSI! (Sound played via pyglet)")
    else:
        SOUND_ENABLED = False
        print(f"[WARNING] Alarm sound file not found at {ALARM_SOUND_PATH}. Sound disabled.")
        def play_alarm_sound_action():
            print("ALARM! MENGANTUK TERDETEKSI! (Sound file not found)")
except Exception as e:
    print(f"[WARNING] Failed to load pyglet or sound file: {e}. Trying winsound.")
    try:
        import winsound
        SOUND_ENABLED = True
        print("[*] Modul 'winsound' berhasil diimpor. Alarm suara aktif.")
        def play_alarm_sound_action():
            winsound.Beep(1000, 1000)
            print("ALARM! MENGANTUK TERDETEKSI! (Sound played via winsound)")
    except ImportError:
        SOUND_ENABLED = False
        print("[WARNING] Modul 'winsound' juga tidak ditemukan. Alarm suara akan dinonaktifkan (print only).")
        def play_alarm_sound_action():
            print("ALARM! MENGANTUK TERDETEKSI! (Suara dinonaktifkan - print only)")


# --- Konstanta Deteksi Kantuk (same as your original code) ---
CONSEC_FRAMES_THRESHOLD = 20
frame_counter_consecutive_closed = 0
alarm_on = False
last_alarm_time = time.time()
ALARM_COOLDOWN = 5

CALIBRATION_FRAMES_TARGET = 60
calibration_ear_values = []
is_calibrated = False
DYNAMIC_EAR_THRESHOLD = 0.25
INITIAL_OPEN_EAR_AVG = 0.30

PERCLOS_WINDOW_SIZE = 90
PERCLOS_THRESHOLD = 0.35
eye_closure_deque = collections.deque(maxlen=PERCLOS_WINDOW_SIZE)

# --- Dlib and OpenCV Setup (same as your original code) ---
print("[*] Memuat Dlib frontal face detector...")
try:
    detector = dlib.get_frontal_face_detector()
    if not os.path.exists(MODEL_PATH):
        print(f"[ERROR] File model Dlib tidak ditemukan di: {MODEL_PATH}")
        predictor = None
    else:
        predictor = dlib.shape_predictor(MODEL_PATH)
    if detector is None or predictor is None:
        raise RuntimeError("Dlib model failed to load.")
    print("[*] Dlib models berhasil dimuat.")
except Exception as e:
    print(f"[ERROR] Gagal memuat model Dlib: {e}")
    detector = None
    predictor = None

print("[*] Mencoba membuka kamera (indeks 0)...")
cap = cv2.VideoCapture(0) # Or specific camera index
if not cap.isOpened():
    print("[ERROR] KRITIS: Tidak dapat membuka kamera.")
    # Exit or handle error appropriately
else:
    print("[*] Kamera berhasil dibuka.")

left_eye_idx = list(range(42, 48))
right_eye_idx = list(range(36, 42))

def calculate_ear(eye):
    A = distance.euclidean(eye[1], eye[5])
    B = distance.euclidean(eye[2], eye[4])
    C = distance.euclidean(eye[0], eye[3])
    if C == 0: return INITIAL_OPEN_EAR_AVG
    return (A + B) / (2.0 * C)

def sound_alarm_thread_target():
    play_alarm_sound_action()

# --- Socket.IO Client Event Handlers ---
@sio.event
def connect():
    print(f"[Socket.IO Client] Terhubung ke Node.js server: {NODE_SERVER_URL}")
    sio.emit('register_driver_vision', {'driverId': DRIVER_ID})

@sio.event
def connect_error(data):
    print(f"[Socket.IO Client] Koneksi gagal! {data}")

@sio.event
def disconnect():
    print("[Socket.IO Client] Terputus dari Node.js server.")

# --- Frame Generation & Drowsiness Logic ---
def generate_frames_and_detect():
    global frame_counter_consecutive_closed, alarm_on, last_alarm_time
    global is_calibrated, DYNAMIC_EAR_THRESHOLD, calibration_ear_values, eye_closure_deque

    if not cap.isOpened():
        print("[generate_frames] ERROR: Kamera tidak terbuka.")
        # Could yield an error frame
        return
    if detector is None or predictor is None:
        print("[generate_frames] ERROR: Model Dlib tidak dimuat.")
        # Could yield an error frame
        return

    print("[generate_frames] Memulai streaming dan deteksi...")
    while True:
        success, frame = cap.read()
        if not success:
            print("[generate_frames] Gagal membaca frame.")
            time.sleep(0.1) # Avoid busy loop if camera fails
            continue
        
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = detector(gray)
        current_ear_val = -1.0
        current_perclos_val = -1.0
        drowsiness_type = ""

        # Emit status to driver's own browser via simple text on frame for now.
        # For more detailed stats, Driver.js would connect to Node.js too.
        # Or Python could use Flask-SocketIO locally for driver's browser if needed.
        # But to keep it simple, alerts go to Node.js.

        if len(faces) > 0:
            face = faces[0] # Assuming one driver
            shape = predictor(gray, face)
            landmarks = np.array([(shape.part(i).x, shape.part(i).y) for i in range(68)])
            
            left_eye = landmarks[left_eye_idx]
            right_eye = landmarks[right_eye_idx]
            left_ear = calculate_ear(left_eye)
            right_ear = calculate_ear(right_eye)
            current_ear_val = (left_ear + right_ear) / 2.0

            if not is_calibrated:
                cv2.putText(frame, "KALIBRASI: Jaga mata terbuka", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
                if len(calibration_ear_values) < CALIBRATION_FRAMES_TARGET:
                    if current_ear_val > 0.15:
                        calibration_ear_values.append(current_ear_val)
                else:
                    if calibration_ear_values:
                        avg_ear = np.mean(calibration_ear_values)
                        DYNAMIC_EAR_THRESHOLD = max(0.10, min(avg_ear * 0.7, 0.35))
                    else: # Fallback if calibration failed
                        DYNAMIC_EAR_THRESHOLD = 0.22
                    is_calibrated = True
                    calibration_ear_values = [] # Reset for potential next calibration
                    print(f"[*] Kalibrasi Selesai. Ambang EAR: {DYNAMIC_EAR_THRESHOLD:.3f}")
            else: # Is calibrated
                cv2.putText(frame, f"EAR: {current_ear_val:.3f} (T: {DYNAMIC_EAR_THRESHOLD:.3f})", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,255,0), 2)
                alarm_triggered_this_frame = False

                # EAR based detection
                if current_ear_val < DYNAMIC_EAR_THRESHOLD:
                    frame_counter_consecutive_closed += 1
                    eye_closure_deque.append(1)
                    if frame_counter_consecutive_closed >= CONSEC_FRAMES_THRESHOLD:
                        drowsiness_type = "EAR"
                        alarm_triggered_this_frame = True
                else:
                    frame_counter_consecutive_closed = 0
                    eye_closure_deque.append(0)

                # PERCLOS based detection
                if len(eye_closure_deque) == PERCLOS_WINDOW_SIZE:
                    current_perclos_val = sum(eye_closure_deque) / PERCLOS_WINDOW_SIZE
                    cv2.putText(frame, f"PERCLOS: {current_perclos_val:.2f}", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,255,0) if current_perclos_val < PERCLOS_THRESHOLD else (0,0,255), 2)
                    if current_perclos_val > PERCLOS_THRESHOLD:
                        drowsiness_type = "PERCLOS" if not drowsiness_type else drowsiness_type + " & PERCLOS"
                        alarm_triggered_this_frame = True
                
                # Alarm logic
                current_time = time.time()
                if alarm_triggered_this_frame:
                    cv2.putText(frame, f"AWAS MENGANTUK! ({drowsiness_type})", (frame.shape[1]//2 - 150, frame.shape[0]//2), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,0,255), 3)
                    if not alarm_on and (current_time - last_alarm_time > ALARM_COOLDOWN):
                        alarm_on = True
                        last_alarm_time = current_time
                        print(f"ALARM! ({drowsiness_type}) EAR: {current_ear_val:.3f}, PERCLOS: {current_perclos_val:.2f}")
                        threading.Thread(target=sound_alarm_thread_target).start()
                        if sio.connected:
                            sio.emit('drowsiness_alert_from_python', {
                                'driverId': DRIVER_ID,
                                'message': f'AWAS! MENGANTUK ({drowsiness_type})',
                                'ear': f"{current_ear_val:.3f}",
                                'perclos': f"{current_perclos_val:.2f}" if current_perclos_val != -1 else "N/A",
                                'threshold': f"{DYNAMIC_EAR_THRESHOLD:.3f}",
                                'type': 'alert'
                            })
                elif alarm_on and not alarm_triggered_this_frame and (current_time - last_alarm_time > ALARM_COOLDOWN):
                    alarm_on = False # Reset alarm
                    print("Kondisi normal kembali.")
                    if sio.connected:
                         sio.emit('drowsiness_alert_from_python', {
                            'driverId': DRIVER_ID,
                            'message': 'Kondisi Normal Kembali',
                            'type': 'normal'
                        })
        else: # No face detected
            cv2.putText(frame, "WAJAH TIDAK TERDETEKSI", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 165, 255), 2)
            eye_closure_deque.append(0) # Assume eyes open if no face detected
            frame_counter_consecutive_closed = 0 # Reset counter if face is lost


        try:
            ret, buffer = cv2.imencode('.jpg', frame)
            if not ret:
                print("[generate_frames] Gagal encode frame.")
                continue
            frame_bytes = buffer.tobytes()
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        except Exception as e:
            print(f"Error encoding/yielding frame: {e}")
            break
        
        sio.sleep(0.01) # Important for python-socketio client in a loop

    if cap.isOpened():
        cap.release()
    print("[generate_frames] Loop Selesai. Kamera dilepas.")

# --- Flask Routes ---
@app.route('/')
def index_driver():
    print("[Flask Route] '/' diakses, menyajikan Driver.html.")
    # Reset state for a new driver session (Python script specific state)
    global is_calibrated, calibration_ear_values, frame_counter_consecutive_closed, alarm_on, eye_closure_deque, last_alarm_time
    is_calibrated = False
    calibration_ear_values = []
    frame_counter_consecutive_closed = 0
    alarm_on = False
    eye_closure_deque.clear()
    last_alarm_time = time.time()
    print("[INFO] Status kalibrasi dan alarm direset untuk sesi driver baru.")
    return render_template('Driver.html', driver_id=DRIVER_ID) # Pass DRIVER_ID to template

@app.route('/video_feed')
def video_feed_route():
    print("[Flask Route] '/video_feed' untuk driver diakses.")
    return Response(generate_frames_and_detect(), mimetype='multipart/x-mixed-replace; boundary=frame')

def run_flask_app():
    # Note: Flask's default dev server is not ideal for multiple simultaneous connections
    # to /video_feed if that were a use case, but for one driver viewing their own feed, it's fine.
    # Use_reloader=False is good when managing global resources like camera and SIO client.
    print(f"[*] Flask server untuk Driver UI berjalan di http://localhost:5005")
    app.run(host='0.0.0.0', port=5005, debug=False, use_reloader=False)


if __name__ == '__main__':
    # Start the Flask app in a separate thread so it doesn't block the SIO client
    flask_thread = threading.Thread(target=run_flask_app)
    flask_thread.daemon = True # So it exits when the main thread exits
    flask_thread.start()

    # Attempt to connect the Socket.IO client
    try:
        print(f"[*] Mencoba menghubungkan Socket.IO client ke {NODE_SERVER_URL}...")
        sio.connect(NODE_SERVER_URL, transports=['websocket']) # Specify websocket
        # Keep the main thread alive to keep the SIO client running
        # sio.wait() # This would block here until sio disconnects.
        # Instead, use a loop to keep main alive, or join the flask_thread if it's not daemon.
        while True:
            time.sleep(1) # Keep main thread alive for SIO client & Flask thread
            if not flask_thread.is_alive():
                print("Flask thread has died.")
                break
            if not sio.connected:
                print("SIO client disconnected, attempting to reconnect...")
                try:
                    sio.connect(NODE_SERVER_URL, transports=['websocket'])
                except socketio.exceptions.ConnectionError as e:
                    print(f"Reconnect failed: {e}")
                    time.sleep(5) # Wait before retrying


    except socketio.exceptions.ConnectionError as e:
        print(f"[Socket.IO Client] Tidak dapat terhubung ke Node.js server di {NODE_SERVER_URL}: {e}")
    except KeyboardInterrupt:
        print("Program dihentikan oleh pengguna.")
    finally:
        if sio.connected:
            sio.disconnect()
        if cap.isOpened():
            cap.release()
        cv2.destroyAllWindows()
        print("Cleanup selesai.")