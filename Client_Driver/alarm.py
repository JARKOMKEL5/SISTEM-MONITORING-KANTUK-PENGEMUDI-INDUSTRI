# === File: drowsiness_detector/alarm.py ===

def check_sound_module():
    try:
        global winsound
        import winsound
        return True
    except ImportError:
        return False

def trigger_alarm(sound_enabled):
    if sound_enabled:
        winsound.Beep(1000, 1000)
    else:
        print("[ALARM] Drowsiness detected! (No sound available)")