# === File: drowsiness_detector/core.py ===
import cv2
import dlib
from flask import Flask, render_template, Response
import time
import os
import numpy as np
import collections
from threading import Thread
from flask_socketio import SocketIO

from .utils import calculate_ear, error_frame
from .alarm import trigger_alarm, check_sound_module
from .calibration import calibrate_ear

class DrowsinessDetector:
    def __init__(self, app: 'Flask', model_path: str, camera_index=0):
        self.socketio = app
        self.model_path = model_path
        self.detector = dlib.get_frontal_face_detector()
        self.predictor = self._load_predictor()
        self.cap = cv2.VideoCapture(camera_index)
        self.left_eye_idx = list(range(42, 48))
        self.right_eye_idx = list(range(36, 42))

        self.calibration_ear_values = []
        self.is_calibrated = False
        self.DYNAMIC_EAR_THRESHOLD = 0.25
        self.CALIBRATION_FRAMES_TARGET = 60

        self.CONSEC_FRAMES_THRESHOLD = 20
        self.frame_counter_consecutive_closed = 0
        self.PERCLOS_WINDOW_SIZE = 90
        self.PERCLOS_THRESHOLD = 0.35
        self.eye_closure_deque = collections.deque(maxlen=self.PERCLOS_WINDOW_SIZE)
        self.alarm_on = False
        self.last_alarm_time = time.time()
        self.ALARM_COOLDOWN = 5

        self.sound_enabled = check_sound_module()

    def _load_predictor(self):
        if not os.path.exists(self.model_path):
            print(f"[ERROR] Model not found: {self.model_path}")
            return None
        return dlib.shape_predictor(self.model_path)

    def generate_frames(self):
        if not self.cap.isOpened():
            yield error_frame("Kamera tidak tersedia")
            return

        while True:
            success, frame = self.cap.read()
            if not success:
                break

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self.detector(gray)

            if len(faces) > 0 and self.predictor:
                face = faces[0]
                shape = self.predictor(gray, face)
                landmarks = [(shape.part(i).x, shape.part(i).y) for i in range(68)]
                left_eye = [landmarks[i] for i in self.left_eye_idx]
                right_eye = [landmarks[i] for i in self.right_eye_idx]

                ear = (calculate_ear(left_eye) + calculate_ear(right_eye)) / 2.0
                perclos = -1
                drowsy = False

                if not self.is_calibrated:
                    calibrate_ear(self, ear)
                else:
                    if ear < self.DYNAMIC_EAR_THRESHOLD:
                        self.frame_counter_consecutive_closed += 1
                        self.eye_closure_deque.append(1)
                        if self.frame_counter_consecutive_closed >= self.CONSEC_FRAMES_THRESHOLD:
                            drowsy = True
                    else:
                        self.frame_counter_consecutive_closed = 0
                        self.eye_closure_deque.append(0)

                    if len(self.eye_closure_deque) == self.PERCLOS_WINDOW_SIZE:
                        closed = sum(self.eye_closure_deque)
                        perclos = closed / self.PERCLOS_WINDOW_SIZE
                        if perclos > self.PERCLOS_THRESHOLD:
                            drowsy = True

                    if drowsy and time.time() - self.last_alarm_time > self.ALARM_COOLDOWN:
                        Thread(target=trigger_alarm, args=(self.sound_enabled,)).start()
                        self.last_alarm_time = time.time()

                cv2.putText(frame, f"EAR: {ear:.2f}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2)
                if perclos >= 0:
                    cv2.putText(frame, f"PERCLOS: {perclos:.2f}", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,255,255), 2)

            ret, buffer = cv2.imencode('.jpg', frame)
            frame_bytes = buffer.tobytes()
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')