# app.py
from flask import Flask, render_template, Response
from flask_socketio import SocketIO, emit
from Client_Driver import DrowsinessDetector
import time

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# Inisialisasi detector dengan Flask app sebagai parameter
model_path = "Client_Driver/model/shape_predictor_68_face_landmarks.dat"
detector = DrowsinessDetector(socketio=socketio, model_path=model_path)

# === Background task untuk broadcast data ke supervisor ===
def background_camera():
    while True:
        frame, data = detector.get_frame()
        if frame is not None:
            socketio.emit("driver_message", data)
        time.sleep(1)

@app.route('/')
def driver():
    return render_template('Driver.html')

@app.route('/supervisor')
def supervisor():
    return render_template('Supervisor.html')

@app.route('/video_feed')
def video_feed():
    return Response(detector.generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

@socketio.on('connect')
def handle_connect():
    print('Client connected')
    emit('server_message', {'data': 'Connected to server'})

@socketio.on('driver_message')
def handle_driver_message(data):
    print('Driver:', data)
    emit('supervisor_message', data, broadcast=True)

@socketio.on('supervisor_message')
def handle_supervisor_message(data):
    print('Supervisor:', data)
    emit('driver_message', data, broadcast=True)

@socketio.on('disconnect')
def handle_disconnect():
    print('Client disconnected')

if __name__ == '__main__':
    socketio.start_background_task(background_camera)
    socketio.run(app, host='http://127.0.0.1', port=5500, debug=True)
