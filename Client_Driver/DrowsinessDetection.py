from flask import Flask, render_template, Response
from flask_socketio import SocketIO, emit # Tambahkan ini
import cv2
import dlib
import numpy as np
from scipy.spatial import distance
import time
import threading
import os
import collections

# --- Konfigurasi Awal & Path ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "model", "shape_predictor_68_face_landmarks.dat")
TEMPLATE_FOLDER = os.path.join(BASE_DIR, "templates")

print(f"[*] Script base directory: {BASE_DIR}")
print(f"[*] Looking for Dlib model at: {MODEL_PATH}")
print(f"[*] Looking for HTML templates in: {TEMPLATE_FOLDER}")

app = Flask(__name__, template_folder=TEMPLATE_FOLDER)
app.config['SECRET_KEY'] = 'ganti_dengan_kunci_rahasia_anda!' # Penting untuk SocketIO
socketio = SocketIO(app) # Inisialisasi SocketIO
print("[*] Aplikasi Flask dan SocketIO diinisialisasi.")

try:
    import winsound
    SOUND_ENABLED = True
    print("[*] Modul 'winsound' berhasil diimpor. Alarm suara aktif.")
    def play_alarm_sound():
        winsound.Beep(1000, 1000)
except ImportError:
    SOUND_ENABLED = False
    print("[WARNING] Modul 'winsound' tidak ditemukan. Alarm suara akan dinonaktifkan.")
    def play_alarm_sound():
        print("ALARM! MENGANTUK TERDETEKSI! (Suara dinonaktifkan)")

# --- Konstanta Deteksi Kantuk ---
CONSEC_FRAMES_THRESHOLD = 20
frame_counter_consecutive_closed = 0
alarm_on = False # Status alarm utama (gabungan EAR & PERCLOS)
last_alarm_time = time.time()
ALARM_COOLDOWN = 5 # Detik

# --- Pengaturan Kalibrasi EAR Dinamis ---
CALIBRATION_FRAMES_TARGET = 60 # Jumlah frame target untuk kalibrasi
calibration_ear_values = []
is_calibrated = False
DYNAMIC_EAR_THRESHOLD = 0.25
INITIAL_OPEN_EAR_AVG = 0.30

# --- Pengaturan PERCLOS ---
PERCLOS_WINDOW_SIZE = 90
PERCLOS_THRESHOLD = 0.35
eye_closure_deque = collections.deque(maxlen=PERCLOS_WINDOW_SIZE)
# perclos_alarm_on = False # Dihapus, cukup gunakan alarm_on

print("[*] Memuat Dlib frontal face detector...")
try:
    detector = dlib.get_frontal_face_detector()
    print("[*] Dlib frontal face detector berhasil dimuat.")
    if not os.path.exists(MODEL_PATH):
        print(f"[ERROR] File model Dlib tidak ditemukan di: {MODEL_PATH}")
        predictor = None
    else:
        predictor = dlib.shape_predictor(MODEL_PATH)
        print("[*] Dlib shape predictor berhasil dimuat.")
except Exception as e:
    print(f"[ERROR] Gagal memuat model Dlib: {e}")
    detector = None
    predictor = None

print("[*] Mencoba membuka kamera (indeks 0)...")
cap = cv2.VideoCapture(0)
if not cap.isOpened():
    print("[ERROR] KRITIS: Tidak dapat membuka kamera.")
else:
    print("[*] Kamera berhasil dibuka.")

left_eye_idx = list(range(42, 48))
right_eye_idx = list(range(36, 42))

def calculate_ear(eye):
    A = distance.euclidean(eye[1], eye[5])
    B = distance.euclidean(eye[2], eye[4])
    C = distance.euclidean(eye[0], eye[3])
    if C == 0: return INITIAL_OPEN_EAR_AVG
    ear_val = (A + B) / (2.0 * C)
    return ear_val

def sound_alarm_thread_target():
    if SOUND_ENABLED: play_alarm_sound()
    else: print("ALARM! MENGANTUK TERDETEKSI! (Suara dinonaktifkan)")


def generate_frames():
    global frame_counter_consecutive_closed, alarm_on, last_alarm_time
    global is_calibrated, DYNAMIC_EAR_THRESHOLD, calibration_ear_values
    global eye_closure_deque

    print("[generate_frames] Dipanggil oleh client.")
    frames_yielded_count = 0
    face_detected_in_session = False

    if not cap.isOpened():
        print("[generate_frames] ERROR: Kamera tidak terbuka.")
        socketio.emit('status_update', {'message': 'Error: Kamera tidak dapat dibuka.', 'type': 'error'})
        return
    if detector is None or predictor is None:
        print("[generate_frames] ERROR: Model Dlib tidak dimuat.")
        socketio.emit('status_update', {'message': 'Error: Model Dlib gagal dimuat.', 'type': 'error'})
        while True: # Tetap stream video dengan pesan error
            success, frame = cap.read()
            if not success: break
            cv2.putText(frame, "ERROR: Model Dlib Gagal Dimuat!", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
            ret, buffer = cv2.imencode('.jpg', frame)
            if not ret: continue
            frame_bytes = buffer.tobytes()
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        return

    # Kirim status awal ke klien
    socketio.emit('status_update', {
        'message': 'Memulai kamera...',
        'is_calibrated': is_calibrated,
        'ear': -1,
        'perclos': -1,
        'dynamic_threshold': DYNAMIC_EAR_THRESHOLD,
        'alarm_active': alarm_on,
        'type': 'info'
    })

    while True:
        success, frame = cap.read()
        if not success:
            print("[generate_frames] Gagal membaca frame.")
            break
        
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = detector(gray)
        current_ear = -1
        current_perclos = -1
        drowsiness_type = "" # Untuk menyimpan tipe peringatan (EAR/PERCLOS)

        if len(faces) > 0:
            face_detected_in_session = True
            face = faces[0]
            shape = predictor(gray, face)
            landmarks = [(shape.part(i).x, shape.part(i).y) for i in range(68)]
            
            left_eye = [landmarks[i] for i in left_eye_idx]
            right_eye = [landmarks[i] for i in right_eye_idx]
            left_ear = calculate_ear(left_eye)
            right_ear = calculate_ear(right_eye)
            current_ear = (left_ear + right_ear) / 2.0

            if not is_calibrated:
                cv2.putText(frame, "KALIBRASI: Jaga mata terbuka normal", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
                socketio.emit('status_update', {'message': 'KALIBRASI: Jaga mata terbuka normal...', 'type': 'calibration_info'})
                if len(calibration_ear_values) < CALIBRATION_FRAMES_TARGET:
                    if current_ear > 0.15:
                         calibration_ear_values.append(current_ear)
                else:
                    if calibration_ear_values:
                        avg_calibrated_ear = np.mean(calibration_ear_values)
                        DYNAMIC_EAR_THRESHOLD = avg_calibrated_ear * 0.70
                        DYNAMIC_EAR_THRESHOLD = max(0.10, min(DYNAMIC_EAR_THRESHOLD, 0.35))
                    else:
                        DYNAMIC_EAR_THRESHOLD = 0.22
                        print("[WARNING] Kalibrasi tidak mendapatkan cukup data, menggunakan default.")
                        socketio.emit('status_update', {'message': 'Warning: Kalibrasi kurang data, threshold default.', 'type': 'warning'})
                    
                    is_calibrated = True
                    print(f"[*] Kalibrasi selesai. Dynamic EAR Threshold: {DYNAMIC_EAR_THRESHOLD:.3f}")
                    socketio.emit('status_update', {
                        'message': f'Kalibrasi Selesai! Threshold: {DYNAMIC_EAR_THRESHOLD:.3f}',
                        'is_calibrated': is_calibrated,
                        'dynamic_threshold': DYNAMIC_EAR_THRESHOLD,
                        'type': 'calibration_done'
                    })
                    calibration_ear_values = []
            
            if is_calibrated:
                alarm_triggered_this_frame = False
                # 1. Deteksi EAR Consecutive
                if current_ear < DYNAMIC_EAR_THRESHOLD:
                    frame_counter_consecutive_closed += 1
                    eye_closure_deque.append(1)
                    if frame_counter_consecutive_closed >= CONSEC_FRAMES_THRESHOLD:
                        cv2.putText(frame, "AWAS! MENGANTUK! (EAR)", (100, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)
                        drowsiness_type = "EAR"
                        alarm_triggered_this_frame = True
                else:
                    frame_counter_consecutive_closed = 0
                    eye_closure_deque.append(0)

                # 2. Deteksi PERCLOS
                if len(eye_closure_deque) == PERCLOS_WINDOW_SIZE:
                    closed_frames_in_window = sum(eye_closure_deque)
                    current_perclos = closed_frames_in_window / PERCLOS_WINDOW_SIZE
                    cv2.putText(frame, f"PERCLOS: {current_perclos:.2f}", (10, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0) if current_perclos < PERCLOS_THRESHOLD else (0,0,255), 2)
                    if current_perclos > PERCLOS_THRESHOLD:
                        cv2.putText(frame, "AWAS! MENGANTUK! (PERCLOS)", (100, 140), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)
                        drowsiness_type = "PERCLOS" if not drowsiness_type else drowsiness_type + " & PERCLOS"
                        alarm_triggered_this_frame = True
                
                # Logika Alarm Gabungan
                current_time = time.time()
                if alarm_triggered_this_frame:
                    if not alarm_on and (current_time - last_alarm_time) > ALARM_COOLDOWN:
                        alarm_on = True
                        last_alarm_time = current_time
                        print(f"[generate_frames] Memicu alarm ({drowsiness_type})!")
                        socketio.emit('drowsiness_alert', {
                            'message': f'AWAS! MENGANTUK TERDETEKSI ({drowsiness_type})',
                            'ear': current_ear,
                            'perclos': current_perclos,
                            'threshold': DYNAMIC_EAR_THRESHOLD,
                            'type': 'alert'
                        })
                        threading.Thread(target=sound_alarm_thread_target).start()
                
                # Reset alarm_on jika kondisi sudah tidak terpenuhi dan cooldown terlewati
                if alarm_on and not alarm_triggered_this_frame and (current_time - last_alarm_time) > ALARM_COOLDOWN:
                    alarm_on = False
                    print("[INFO] Kondisi alarm berakhir, alarm direset.")
                    socketio.emit('drowsiness_alert', {'message': 'Kondisi Normal Kembali', 'type': 'normal'})


            cv2.putText(frame, f"EAR: {current_ear:.3f}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 0), 2)
            if is_calibrated:
                 cv2.putText(frame, f"Thresh: {DYNAMIC_EAR_THRESHOLD:.3f}", (10, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 0), 2) # Sesuaikan posisi Y

        else: # Wajah tidak terdeteksi
            eye_closure_deque.append(0) # Asumsi mata terbuka
            message_no_face = "ARAHKAN WAJAH KE KAMERA"
            if is_calibrated and face_detected_in_session:
                message_no_face = "WAJAH TIDAK TERDETEKSI"
            cv2.putText(frame, message_no_face, (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 165, 255), 2)
            # Kirim status wajah tidak terdeteksi via WebSocket
            socketio.emit('status_update', {
                'message': message_no_face,
                'is_calibrated': is_calibrated,
                'ear': -1, 'perclos': -1,
                'alarm_active': alarm_on,
                'type': 'no_face'
            })

        # Kirim data periodik via WebSocket jika wajah terdeteksi
        if len(faces) > 0:
            socketio.emit('update_data', {
                'ear': current_ear,
                'perclos': current_perclos if len(eye_closure_deque) == PERCLOS_WINDOW_SIZE else -1,
                'is_calibrated': is_calibrated,
                'dynamic_threshold': DYNAMIC_EAR_THRESHOLD,
                'alarm_active': alarm_on,
                'message': 'Memantau...' if is_calibrated else 'Proses Kalibrasi...'
            })
        
        ret, buffer = cv2.imencode('.jpg', frame)
        if not ret:
            print("[generate_frames] Gagal encode frame.")
            continue
            
        frame_bytes = buffer.tobytes()
        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        frames_yielded_count +=1
        socketio.sleep(0.01) # Beri sedikit waktu untuk proses lain, termasuk WebSocket

    print(f"[generate_frames] Loop selesai. Total frame di-yield: {frames_yielded_count}")


@app.route('/')
def index():
    print("[Flask Route] '/' diakses, menyajikan Driver.html.")
    global is_calibrated, calibration_ear_values, frame_counter_consecutive_closed, alarm_on, eye_closure_deque, last_alarm_time
    is_calibrated = False
    calibration_ear_values = []
    frame_counter_consecutive_closed = 0
    alarm_on = False
    eye_closure_deque.clear()
    last_alarm_time = time.time()
    print("[INFO] Status kalibrasi dan alarm direset untuk sesi baru.")
    return render_template('Driver.html') # Nama file HTML Anda

@app.route('/video_feed')
def video_feed():
    print("[Flask Route] '/video_feed' diakses.")
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == '__main__':
    print("[*] Memulai server Flask dengan SocketIO...")
    print("[*] Buka browser dan akses: http://127.0.0.1:5000/")
    # Jalankan dengan socketio.run() dan eventlet jika sudah diinstal
    # socketio.run(app, debug=True, use_reloader=False, host='0.0.0.0', port=5000)
    socketio.run(app, debug=True, use_reloader=False) # Defaultnya Flask dev server, untuk eventlet/gevent perlu setup berbeda