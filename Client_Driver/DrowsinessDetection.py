from flask import Flask, render_template, Response, request, jsonify
from flask_socketio import SocketIO, emit
import cv2
import dlib
import numpy as np
from scipy.spatial import distance
import time
import threading
import os
import collections
import traceback # Untuk debugging exception

# --- Konfigurasi Awal & Path ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "model", "shape_predictor_68_face_landmarks.dat")
TEMPLATE_FOLDER = os.path.join(BASE_DIR, "templates")

print(f"[*] Script base directory: {BASE_DIR}")
print(f"[*] Looking for Dlib model at: {MODEL_PATH}")
print(f"[*] Looking for HTML templates in: {TEMPLATE_FOLDER}")

app = Flask(__name__, template_folder=TEMPLATE_FOLDER)
app.config['SECRET_KEY'] = 'kunci_rahasia_anda_yang_sangat_aman_dan_unik!' # GANTI INI!
socketio = SocketIO(app, cors_allowed_origins="*")
print("[*] Aplikasi Flask dan SocketIO diinisialisasi.")

call_status_http = {'in_call': False, 'call_type': None }
camera_requested_by_webrtc = False

try:
    import winsound
    SOUND_ENABLED = True
    print("[*] Modul 'winsound' berhasil diimpor. Alarm suara aktif.")
    def play_alarm_sound_internal(): winsound.Beep(1000, 1000)
except ImportError:
    SOUND_ENABLED = False
    print("[WARNING] Modul 'winsound' tidak ditemukan. Alarm suara akan dinonaktifkan.")
    def play_alarm_sound_internal(): print("ALARM! MENGANTUK TERDETEKSI! (Suara dinonaktifkan)")

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

cap = None
camera_lock = threading.Lock()
active_sio_clients = 0

left_eye_idx = list(range(42, 48))
right_eye_idx = list(range(36, 42))

def calculate_ear(eye_landmarks):
    A = distance.euclidean(eye_landmarks[1], eye_landmarks[5])
    B = distance.euclidean(eye_landmarks[2], eye_landmarks[4])
    C = distance.euclidean(eye_landmarks[0], eye_landmarks[3])
    if C == 0: return INITIAL_OPEN_EAR_AVG
    return (A + B) / (2.0 * C)

def sound_alarm_thread_target():
    if SOUND_ENABLED: play_alarm_sound_internal()
    else: print("ALARM! MENGANTUK TERDETEKSI! (Suara dinonaktifkan)")

def reset_detection_state(source="unknown"):
    global is_calibrated, calibration_ear_values, frame_counter_consecutive_closed, alarm_on, eye_closure_deque, last_alarm_time, DYNAMIC_EAR_THRESHOLD
    is_calibrated = False
    calibration_ear_values = []
    frame_counter_consecutive_closed = 0
    alarm_on = False
    eye_closure_deque.clear()
    last_alarm_time = time.time()
    DYNAMIC_EAR_THRESHOLD = 0.25
    print(f"[INFO] Status deteksi dan kalibrasi direset (sumber: {source}).")
    socketio.emit('status_update', {
        'message': 'Kalibrasi dimulai ulang...', 'is_calibrated': False,
        'dynamic_threshold': DYNAMIC_EAR_THRESHOLD, 'type': 'calibration_info'
    })

@socketio.on('connect')
def handle_connect():
    global cap, active_sio_clients, camera_lock, camera_requested_by_webrtc, is_calibrated, DYNAMIC_EAR_THRESHOLD
    with camera_lock:
        active_sio_clients += 1
        print(f"[SocketIO] Klien terhubung (SID: {request.sid}). Klien aktif: {active_sio_clients}")
        
        cam_status_message = 'Terhubung ke server deteksi.'
        current_cam_ready = False
        trigger_reset = False # Flag apakah reset_detection_state perlu dipanggil

        if camera_requested_by_webrtc:
            print("[Kamera] handle_connect: Kamera sedang diminta oleh WebRTC. Tidak ada aksi kamera.")
            cam_status_message = 'Terhubung, kamera digunakan WebRTC.'
        elif call_status_http['in_call']:
            print("[Kamera] handle_connect: Panggilan HTTP aktif. Tidak ada aksi kamera.")
            cam_status_message = 'Terhubung, kamera digunakan panggilan HTTP.'
        elif cap is None:
            print("[Kamera] handle_connect: Kamera belum ada, mencoba membuka...")
            cap = cv2.VideoCapture(0)
            if cap.isOpened():
                print("[Kamera] handle_connect: Kamera berhasil diakuisisi.")
                trigger_reset = True # Akan memanggil reset_detection_state
                cam_status_message = "Terhubung. Kalibrasi dimulai..." 
                current_cam_ready = True
            else:
                print("[ERROR] handle_connect: GAGAL mengakuisisi kamera.")
                cap = None
                cam_status_message = 'Terhubung, GAGAL buka kamera deteksi.'
        elif cap.isOpened():
            print("[Kamera] handle_connect: Kamera sudah aktif dan terbuka.")
            current_cam_ready = True
            cam_status_message = "Terhubung. Status deteksi: " + ("Memantau" if is_calibrated else "Kalibrasi")
        else: 
            print("[Kamera] handle_connect: Kamera ada tapi tidak terbuka. Mencoba membuka ulang...")
            cap.release() 
            cap = cv2.VideoCapture(0)
            if cap.isOpened():
                print("[Kamera] handle_connect: Kamera berhasil dibuka ulang.")
                trigger_reset = True
                cam_status_message = "Terhubung. Kalibrasi dimulai..."
                current_cam_ready = True
            else:
                print("[ERROR] handle_connect: GAGAL membuka ulang kamera.")
                cap = None
                cam_status_message = 'Terhubung, GAGAL membuka ulang kamera deteksi.'
        
        if trigger_reset:
            reset_detection_state(source="handle_connect_new_or_reopened_cap")
        else: # Emit status jika reset tidak dipanggil (karena reset sudah emit sendiri)
            socketio.emit('status_update', {
                'message': cam_status_message,
                'is_calibrated': is_calibrated if current_cam_ready else False,
                'dynamic_threshold': DYNAMIC_EAR_THRESHOLD if current_cam_ready and is_calibrated else None,
                'type': 'info' if current_cam_ready else ('error' if "GAGAL" in cam_status_message else 'info')
            }, room=request.sid)


@socketio.on('disconnect')
def handle_disconnect():
    global cap, active_sio_clients, camera_lock, camera_requested_by_webrtc
    with camera_lock:
        active_sio_clients -= 1
        print(f"[SocketIO] Klien terputus (SID: {request.sid}). Klien aktif: {active_sio_clients}")
        if active_sio_clients <= 0 and not call_status_http['in_call'] and not camera_requested_by_webrtc:
            active_sio_clients = 0 
            if cap is not None:
                print("[Kamera] Tidak ada klien aktif & kamera bebas, melepaskan kamera...")
                cap.release()
                cap = None
                print("[Kamera] Kamera berhasil dilepaskan.")

@socketio.on('request_camera_release')
def handle_request_camera_release(data):
    global cap, camera_lock, camera_requested_by_webrtc
    sid = request.sid; driver_id_log = data.get('driver_id', 'N/A')
    print(f"[SocketIO] Klien {sid} (Driver: {driver_id_log}) -> PELEPASAN kamera untuk WebRTC.")
    with camera_lock:
        camera_requested_by_webrtc = True 
        if cap is not None:
            print("[Kamera] Melepaskan `cap` atas permintaan Driver.js...")
            cap.release()
            cap = None
            print("[Kamera] `cap` DILEPASKAN untuk WebRTC.")
            socketio.emit('status_update', {'message': 'Kamera internal dilepaskan untuk WebRTC.', 'type': 'info'})
        else:
            print("[Kamera] `cap` sudah tidak aktif, tidak ada yang dilepaskan.")
            socketio.emit('status_update', {'message': 'Kamera internal sudah nonaktif.', 'type': 'info'})

@socketio.on('request_camera_acquire')
def handle_request_camera_acquire(data):
    global cap, camera_lock, active_sio_clients, camera_requested_by_webrtc, is_calibrated
    sid = request.sid; driver_id_log = data.get('driver_id', 'N/A')
    print(f"[SocketIO] Klien {sid} (Driver: {driver_id_log}) -> AKUISISI kamera kembali pasca-WebRTC.")
    
    success_reacquire = False
    trigger_reset_after_acquire = False
    with camera_lock:
        camera_requested_by_webrtc = False 
        if active_sio_clients > 0 and cap is None and not call_status_http['in_call']:
            print("[Kamera] Mencoba akuisisi `cap` kembali (attempt 1)...")
            cap = cv2.VideoCapture(0)
            if cap.isOpened():
                print("[Kamera] SUKSES akuisisi `cap` (attempt 1).")
                trigger_reset_after_acquire = True
                success_reacquire = True
            else:
                print("[Kamera] GAGAL akuisisi `cap` (attempt 1). Mencoba lagi setelah delay...")
                cap = None 
                socketio.sleep(0.5) 
                cap = cv2.VideoCapture(0)
                if cap.isOpened():
                    print("[Kamera] SUKSES akuisisi `cap` (attempt 2).")
                    trigger_reset_after_acquire = True
                    success_reacquire = True
                else:
                    print("[ERROR] GAGAL TOTAL akuisisi `cap` kembali setelah 2 attempt.")
                    cap = None
        elif cap is not None and cap.isOpened():
             print("[Kamera] `cap` sudah aktif, tidak perlu akuisisi ulang.")
             success_reacquire = True 
        elif active_sio_clients <= 0:
             print("[Kamera] Tidak ada klien aktif, `cap` tidak diakuisisi ulang.")
        elif call_status_http['in_call']:
            print("[Kamera] Panggilan HTTP aktif, akuisisi `cap` ditunda.")
    
    if trigger_reset_after_acquire:
        reset_detection_state(source="request_camera_acquire_success")

    if not success_reacquire and active_sio_clients > 0 :
        print(f"[SocketIO] Gagal akuisisi `cap` pasca-WebRTC, mengirim error ke klien.")
        socketio.emit('status_update', {'message': 'Gagal memulai ulang kamera deteksi pasca-WebRTC.', 'type': 'error'})


def generate_frames():
    global cap, camera_lock, call_status_http, camera_requested_by_webrtc
    global frame_counter_consecutive_closed, alarm_on, last_alarm_time
    global is_calibrated, DYNAMIC_EAR_THRESHOLD, calibration_ear_values, eye_closure_deque

    # print("[generate_frames] Memulai generator video stream.") # Bisa terlalu verbose
    frames_yielded_count = 0
    
    if detector is None or predictor is None:
        print("[generate_frames] ERROR: Model Dlib tidak dimuat! Mengirim frame error statis.")
        while True: 
            error_img = np.zeros((480, 640, 3), dtype=np.uint8)
            cv2.putText(error_img, "ERROR: Model Dlib Gagal Dimuat!", (50, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
            ret, buffer = cv2.imencode('.jpg', error_img)
            if ret:
                try:
                    yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
                    frames_yielded_count +=1
                except GeneratorExit: print("[generate_frames] Client (Dlib error stream) disconnected."); return
                except ConnectionAbortedError: print("[generate_frames] Client (Dlib error stream) connection aborted."); return
            socketio.sleep(1)

    try:
        while True:
            if camera_requested_by_webrtc:
                webrtc_frame_img = np.zeros((480, 640, 3), dtype=np.uint8)
                cv2.putText(webrtc_frame_img, "KAMERA DIGUNAKAN UNTUK PANGGILAN (WebRTC)", (10, 240),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 2)
                ret, buffer = cv2.imencode('.jpg', webrtc_frame_img)
                if ret:
                    try:
                        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
                        frames_yielded_count += 1
                    except (GeneratorExit, ConnectionAbortedError):
                        print("[generate_frames] Client (WebRTC placeholder stream) disconnected or aborted.")
                        return
                socketio.sleep(0.5)
                continue

            if call_status_http['in_call']:
                http_call_frame_img = np.zeros((480, 640, 3), dtype=np.uint8)
                cv2.putText(http_call_frame_img, "DETEKSI DIJEDA: PANGGILAN HTTP AKTIF", (20, 240), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 200, 200), 2)
                ret, buffer = cv2.imencode('.jpg', http_call_frame_img)
                if ret:
                    try:
                        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
                        frames_yielded_count += 1
                    except (GeneratorExit, ConnectionAbortedError):
                        print("[generate_frames] Client (HTTP call placeholder stream) disconnected or aborted.")
                        return
                socketio.sleep(0.5)
                continue

            current_frame_to_process = None
            acquired_successfully = False
            with camera_lock:
                if cap is not None and cap.isOpened():
                    success, frame = cap.read()
                    if success:
                        current_frame_to_process = frame.copy()
                        acquired_successfully = True
                    else:
                        print("[generate_frames] Gagal baca frame dari kamera terbuka.")
            
            if not acquired_successfully:
                cam_unavailable_img = np.zeros((480, 640, 3), dtype=np.uint8)
                status_text = "Kamera Deteksi Tidak Aktif."
                if camera_requested_by_webrtc: # Seharusnya sudah ditangani di atas
                    status_text = "Kamera digunakan WebRTC." 
                elif not (cap and cap.isOpened()): 
                    status_text = "Kamera Deteksi Tidak Aktif."
                
                cv2.putText(cam_unavailable_img, status_text, (50, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
                if status_text == "Kamera Deteksi Tidak Aktif.":
                     cv2.putText(cam_unavailable_img, "Pastikan Driver.js terhubung.", (50, 280), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
                
                ret, buffer = cv2.imencode('.jpg', cam_unavailable_img)
                if ret:
                    try:
                        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
                        frames_yielded_count += 1
                    except (GeneratorExit, ConnectionAbortedError):
                        print("[generate_frames] Client (cam unavailable stream) disconnected or aborted.")
                        return
                socketio.sleep(0.5)
                continue
            
            # ---- MULAI LOGIKA DETEKSI KANTUK ----
            gray = cv2.cvtColor(current_frame_to_process, cv2.COLOR_BGR2GRAY); faces = detector(gray); ear_value_current_frame = -1; perclos_value_current_frame = -1
            if not faces:
                if not alarm_on : socketio.emit('status_update', {'message': 'Tidak ada wajah terdeteksi.', 'type': 'no_face', 'is_calibrated': is_calibrated, 'dynamic_threshold': DYNAMIC_EAR_THRESHOLD if is_calibrated else None})
                frame_counter_consecutive_closed = 0; eye_closure_deque.clear()
            else: 
                face = faces[0]; landmarks = predictor(gray, face); left_eye_coords = np.array([(landmarks.part(i).x, landmarks.part(i).y) for i in left_eye_idx]); right_eye_coords = np.array([(landmarks.part(i).x, landmarks.part(i).y) for i in right_eye_idx]); left_ear = calculate_ear(left_eye_coords); right_ear = calculate_ear(right_eye_coords); ear_value_current_frame = (left_ear + right_ear) / 2.0
                if not is_calibrated:
                    calibration_ear_values.append(ear_value_current_frame); cal_progress = len(calibration_ear_values) / CALIBRATION_FRAMES_TARGET * 100
                    socketio.emit('status_update', { 'message': f"Kalibrasi: {len(calibration_ear_values)}/{CALIBRATION_FRAMES_TARGET} ({cal_progress:.0f}%)", 'type': 'calibration_info', 'is_calibrated': False, 'dynamic_threshold': DYNAMIC_EAR_THRESHOLD })
                    if len(calibration_ear_values) >= CALIBRATION_FRAMES_TARGET:
                        avg_open_ear = np.mean(calibration_ear_values) if calibration_ear_values else INITIAL_OPEN_EAR_AVG; DYNAMIC_EAR_THRESHOLD = max(0.1, min(0.35, avg_open_ear * 0.75)); is_calibrated = True; calibration_ear_values = []
                        socketio.emit('status_update', { 'message': f"Kalibrasi Selesai! Threshold: {DYNAMIC_EAR_THRESHOLD:.3f}", 'type': 'calibration_done', 'is_calibrated': True, 'dynamic_threshold': DYNAMIC_EAR_THRESHOLD }); print(f"[Kalibrasi] Selesai. Avg Open EAR: {avg_open_ear:.3f}, Threshold: {DYNAMIC_EAR_THRESHOLD:.3f}")
                else: 
                    if ear_value_current_frame < DYNAMIC_EAR_THRESHOLD: frame_counter_consecutive_closed += 1; eye_closure_deque.append(1)
                    else:
                        if frame_counter_consecutive_closed > 0 and alarm_on: print("[Deteksi] Mata terbuka, alarm nonaktif."); alarm_on = False; socketio.emit('drowsiness_alert', {'message': 'Pengemudi kembali sadar.', 'type': 'normal', 'is_calibrated': True})
                        frame_counter_consecutive_closed = 0; eye_closure_deque.append(0)
                    if len(eye_closure_deque) == PERCLOS_WINDOW_SIZE: perclos_value_current_frame = sum(eye_closure_deque) / PERCLOS_WINDOW_SIZE
                    drowsiness_detected_reason = None
                    if frame_counter_consecutive_closed >= CONSEC_FRAMES_THRESHOLD: drowsiness_detected_reason = f"EAR < Threshold ({frame_counter_consecutive_closed} frames)"
                    elif perclos_value_current_frame != -1 and perclos_value_current_frame >= PERCLOS_THRESHOLD: drowsiness_detected_reason = f"PERCLOS tinggi ({perclos_value_current_frame*100:.1f}%)"
                    if drowsiness_detected_reason and not alarm_on and (time.time() - last_alarm_time) > ALARM_COOLDOWN:
                        alarm_on = True; last_alarm_time = time.time(); print(f"[ALARM] Kantuk! {drowsiness_detected_reason}"); threading.Thread(target=sound_alarm_thread_target).start()
                        socketio.emit('drowsiness_alert', { 'message': f"PERINGATAN KANTUK! {drowsiness_detected_reason}", 'type': 'alert', 'ear': ear_value_current_frame, 'perclos': perclos_value_current_frame, 'is_calibrated': True })
                    elif not drowsiness_detected_reason and alarm_on: print("[Deteksi] Kondisi normal, alarm nonaktif."); alarm_on = False; socketio.emit('drowsiness_alert', {'message': 'Pengemudi kembali sadar.', 'type': 'normal', 'is_calibrated': True})
            if is_calibrated: cv2.putText(current_frame_to_process, f"EAR: {ear_value_current_frame:.3f} (T: {DYNAMIC_EAR_THRESHOLD:.3f})", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0) if ear_value_current_frame >= DYNAMIC_EAR_THRESHOLD else (0, 0, 255), 1);_ = cv2.putText(current_frame_to_process, f"PERCLOS: {perclos_value_current_frame*100:.1f}%", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0) if perclos_value_current_frame < PERCLOS_THRESHOLD else (0, 0, 255), 1) if perclos_value_current_frame != -1 else None ;cv2.putText(current_frame_to_process, "Status: Memantau", (10, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0) if not alarm_on else (0,165,255), 1)
            else: cv2.putText(current_frame_to_process, "Status: Kalibrasi...", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 192, 0), 2); _ = cv2.putText(current_frame_to_process, f"EAR: {ear_value_current_frame:.3f}", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 192, 0), 1) if ear_value_current_frame != -1 else None
            if alarm_on: cv2.putText(current_frame_to_process, "ALARM KANTUK!", (current_frame_to_process.shape[1] // 2 - 100, current_frame_to_process.shape[0] - 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,0,255), 2)
            socketio.emit('update_data', { 'ear': ear_value_current_frame if ear_value_current_frame != -1 else None, 'perclos': perclos_value_current_frame if perclos_value_current_frame != -1 else None, 'is_calibrated': is_calibrated, 'dynamic_threshold': DYNAMIC_EAR_THRESHOLD if is_calibrated else None, 'alarm_on': alarm_on })
            # ---- AKHIR LOGIKA DETEKSI KANTUK ----

            ret, buffer = cv2.imencode('.jpg', current_frame_to_process)
            if not ret: print("[generate_frames] Gagal encode frame."); continue
            frame_bytes = buffer.tobytes()
            try:
                yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n'); frames_yielded_count +=1
            except ConnectionAbortedError: print("[generate_frames] Koneksi diaborsi oleh klien (yield)."); return
            except GeneratorExit: print("[generate_frames] Client disconnected (yield)."); return
            socketio.sleep(0.03) 
    except Exception as e:
        print(f"[generate_frames] Exception dalam loop utama generator: {e}")
        traceback.print_exc()
    finally:
        print(f"[generate_frames] Keluar dari generator. Total frame di-yield: {frames_yielded_count}.")

@app.route('/')
def index_route(): return render_template('Driver.html') 

@app.route('/video_feed')
def video_feed(): return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

# Endpoint HTTP opsional
@app.route('/start_call_http', methods=['POST'])
def start_call_http():
    global cap, call_status_http, camera_lock
    with camera_lock:
        call_type = request.json.get('call_type', 'video')
        call_status_http['in_call'] = True
        call_status_http['call_type'] = call_type
        print(f"[Panggilan HTTP] Panggilan '{call_type}' dimulai.")
        if cap is not None and not camera_requested_by_webrtc:
            print("[Panggilan HTTP] Melepaskan kamera deteksi...")
            cap.release(); cap = None
    socketio.emit('status_update', {'message': 'Kamera digunakan untuk panggilan HTTP.', 'type': 'info'})
    return jsonify({'status': 'success', 'message': f'Panggilan HTTP {call_type} dimulai'})

@app.route('/end_call_http', methods=['POST'])
def end_call_http():
    global cap, call_status_http, active_sio_clients, camera_lock, is_calibrated
    with camera_lock:
        print("[Panggilan HTTP] Panggilan diakhiri.")
        call_status_http['in_call'] = False
        call_status_http['call_type'] = None
        if active_sio_clients > 0 and cap is None and not camera_requested_by_webrtc:
            print("[Panggilan HTTP] Mengembalikan kamera ke deteksi...")
            cap = cv2.VideoCapture(0)
            if cap.isOpened(): reset_detection_state(source="end_call_http")
            else: cap = None
    if cap and cap.isOpened():
         socketio.emit('status_update', {'message': 'Deteksi kantuk dilanjutkan (pasca HTTP call).', 'type': 'info', 'is_calibrated': is_calibrated})
    return jsonify({'status': 'success', 'message': 'Panggilan HTTP diakhiri'})


if __name__ == '__main__':
    print("[*] Memulai server Flask dengan SocketIO...")
    if predictor is None or detector is None: print("[FATAL ERROR] Model Dlib tidak berhasil dimuat.")
    print("[*] Server berjalan di http://0.0.0.0:5000/")
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, use_reloader=False)