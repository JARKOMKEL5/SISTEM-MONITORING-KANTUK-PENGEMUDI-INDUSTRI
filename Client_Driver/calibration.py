# === File: drowsiness_detector/calibration.py ===
import numpy as np

def calibrate_ear(detector, ear):
    if ear > 0.15:
        detector.calibration_ear_values.append(ear)
    if len(detector.calibration_ear_values) >= detector.CALIBRATION_FRAMES_TARGET:
        mean_ear = np.mean(detector.calibration_ear_values)
        detector.DYNAMIC_EAR_THRESHOLD = max(0.1, min(mean_ear * 0.7, 0.35))
        detector.is_calibrated = True
        detector.socketio.emit('status_update', {
            'message': f'Kalibrasi selesai. EAR threshold: {detector.DYNAMIC_EAR_THRESHOLD:.2f}',
            'is_calibrated': True,
            'type': 'calibration_done'
        })
        detector.calibration_ear_values.clear()
