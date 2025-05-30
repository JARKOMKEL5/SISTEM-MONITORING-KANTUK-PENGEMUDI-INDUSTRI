from flask import Flask, render_template
from flask_socketio import SocketIO, emit

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

@app.route('/')
def index():
    return render_template('Driver.html')  # Halaman Driver

@app.route('/supervisor')
def supervisor():
    return render_template('Supervisor.html')


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
    from Client_Driver import DrowsinessDetector  # pastikan __init__.py memuat ini

    # Buat instance dan jalankan sebagai background task
    detector = DrowsinessDetector(socketio, model_path="Client_Driver/model/shape_predictor_68_face_landmarks.dat")
    socketio.start_background_task(detector.run)

    # Jalankan Flask app
    socketio.run(app, host='localhost', port=5500, debug=True)
