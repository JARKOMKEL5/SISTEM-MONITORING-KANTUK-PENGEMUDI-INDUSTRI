# app.py
from flask import Flask, render_template, Response
from flask_socketio import SocketIO, emit
from Client_Driver import DrowsinessDetector

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# Inisialisasi detector dengan Flask app sebagai parameter
model_path = "Client_Driver/model/shape_predictor_68_face_landmarks.dat"
detector = DrowsinessDetector(app, model_path=model_path)

def background_camera():
    for frame in detector.generate_frames():
        # Di sini bisa ditambahkan logika emit frame ke frontend jika dibutuhkan
        pass

@app.route('/')
def index():
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
    socketio.run(app, host='localhost', port=5500, debug=True)
