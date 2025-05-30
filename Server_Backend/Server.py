from flask import Flask, render_template
from flask_socketio import SocketIO, emit

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

@app.route('/')
def index():
    return render_template('Driver.html')  # Halaman Driver

@app.route('/supervisor')
def supervisor():
    return render_template('supervisor.html')


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
    socketio.run(app, host='localhost', port=5000, debug=True)
