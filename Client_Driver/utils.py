# === File: drowsiness_detector/utils.py ===
import cv2
import numpy as np
from scipy.spatial import distance

def calculate_ear(eye):
    A = distance.euclidean(eye[1], eye[5])
    B = distance.euclidean(eye[2], eye[4])
    C = distance.euclidean(eye[0], eye[3])
    if C == 0:
        return 0.3
    return (A + B) / (2.0 * C)

def error_frame(message):
    blank_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    cv2.putText(blank_frame, message, (30, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,0,255), 2)
    ret, buffer = cv2.imencode('.jpg', blank_frame)
    return (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')