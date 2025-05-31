import subprocess
import os
import sys
import time
import signal
import threading

# --- Konfigurasi Path ---
# Asumsi Launcher.py ada di root folder proyek
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

# Path ke skrip server dan direktori kerjanya
SERVER_CV_SCRIPT = os.path.join(ROOT_DIR, "Client_Driver", "DrowsinessDetection.py")
SERVER_CV_CWD = os.path.join(ROOT_DIR, "Client_Driver")

SERVER_RTC_SCRIPT = os.path.join(ROOT_DIR, "Server_Backend", "Server.py")
SERVER_RTC_CWD = os.path.join(ROOT_DIR, "Server_Backend")

# Proses yang berjalan
processes = []

def print_stream_output(stream, prefix):
    """Membaca dan mencetak output dari stream subprocess secara real-time."""
    try:
        for line in iter(stream.readline, ""):
            if line: # Hanya cetak jika ada baris
                print(f"[{prefix}] {line.strip()}", flush=True)
    except ValueError: # Stream mungkin sudah ditutup
        pass
    finally:
        if hasattr(stream, 'close') and not stream.closed:
            stream.close()


def start_server(script_path, working_dir, server_name):
    """Memulai server sebagai subprocess dan memantau outputnya."""
    if not os.path.exists(script_path):
        print(f"Error: Skrip {server_name} tidak ditemukan di {script_path}", flush=True)
        return None
    if not os.path.isdir(working_dir):
        print(f"Error: Direktori kerja untuk {server_name} tidak ditemukan di {working_dir}", flush=True)
        return None

    try:
        # Menggunakan sys.executable untuk memastikan interpreter Python yang sama digunakan
        # Popen memungkinkan kita mengelola proses secara lebih fleksibel
        # stdout dan stderr di-pipe agar bisa kita baca
        # text=True (atau universal_newlines=True) untuk output sebagai string
        # bufsize=1 untuk line buffering
        # Pastikan Flask dev server (jika debug=True di DrowsinessDetection.py) tidak menggunakan reloader
        # karena itu akan membuat proses child tambahan yang sulit di-manage oleh launcher ini.
        # Idealnya, 'use_reloader=False' di DrowsinessDetection.py jika debug=True.
        process = subprocess.Popen(
            [sys.executable, script_path],
            cwd=working_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        print(f"Memulai {server_name} (PID: {process.pid})...", flush=True)

        # Buat thread untuk membaca stdout dan stderr tanpa memblokir
        stdout_thread = threading.Thread(target=print_stream_output, args=(process.stdout, f"{server_name}-OUT"), daemon=True)
        stderr_thread = threading.Thread(target=print_stream_output, args=(process.stderr, f"{server_name}-ERR"), daemon=True)
        stdout_thread.start()
        stderr_thread.start()

        processes.append(process)
        return process
    except Exception as e:
        print(f"Gagal memulai {server_name}: {e}", flush=True)
        return None

def stop_servers():
    """Menghentikan semua server yang telah dimulai."""
    print("\nMenghentikan semua server...", flush=True)
    for process in processes:
        if process.poll() is None: # Jika proses masih berjalan
            print(f"Mengirim sinyal terminasi ke PID {process.pid}...", flush=True)
            try:
                # Di Windows, terminate() adalah alias untuk TerminateProcess()
                # Di Unix, mengirim SIGTERM
                process.terminate()
            except Exception as e:
                print(f"Error saat terminasi PID {process.pid}: {e}", flush=True)
                try:
                    process.kill() # Paksa jika terminate gagal
                except Exception as e_kill:
                     print(f"Error saat kill PID {process.pid}: {e_kill}", flush=True)


    # Beri waktu untuk proses berhenti
    for process in processes:
        if process.poll() is None:
            try:
                process.wait(timeout=5) # Tunggu maksimal 5 detik
            except subprocess.TimeoutExpired:
                print(f"PID {process.pid} tidak berhenti setelah 5 detik, memaksa kill...", flush=True)
                try:
                    process.kill()
                    process.wait(timeout=2) # Tunggu lagi setelah kill
                except Exception as e:
                    print(f"Error saat kill paksa PID {process.pid}: {e}", flush=True)
            except Exception as e:
                 print(f"Error saat menunggu PID {process.pid}: {e}", flush=True)
        # Pastikan stream ditutup
        if hasattr(process.stdout, 'close') and not process.stdout.closed : process.stdout.close()
        if hasattr(process.stderr, 'close') and not process.stderr.closed : process.stderr.close()


    print("Semua server telah diinstruksikan untuk berhenti.", flush=True)

# Handler untuk Ctrl+C
def signal_handler(sig, frame):
    print("\nCtrl+C terdeteksi!", flush=True)
    stop_servers()
    sys.exit(0)

if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)  # Menangani Ctrl+C

    print("="*50, flush=True)
    print(" Launcher Multi-Server Sistem Monitoring Kantuk ".center(50), flush=True)
    print("="*50, flush=True)
    print(f"ROOT_DIR: {ROOT_DIR}", flush=True)


    # Memulai server-server
    print("\n--- Memulai Server Deteksi Kantuk (Flask/OpenCV) ---", flush=True)
    start_server(SERVER_CV_SCRIPT, SERVER_CV_CWD, "ServerCV")

    print("\n--- Memulai Server WebRTC & Frontend (Aiohttp) ---", flush=True)
    start_server(SERVER_RTC_SCRIPT, SERVER_RTC_CWD, "ServerRTC")

    print("\nKedua server telah dimulai. Tekan Ctrl+C untuk menghentikan semua.", flush=True)
    print("Perhatikan output dari masing-masing server di atas.", flush=True)

    # Biarkan launcher berjalan sampai dihentikan (misalnya dengan Ctrl+C)
    # Atau bisa juga menunggu semua proses selesai jika mereka bisa berhenti sendiri
    try:
        while True:
            # Cek apakah ada proses yang berhenti sendiri
            all_stopped = True
            for p in processes:
                if p.poll() is None: # Jika ada yang masih berjalan
                    all_stopped = False
                    break
            if all_stopped and processes: # Jika semua sudah berhenti dan ada proses yang dijalankan
                print("Semua server telah berhenti sendiri.", flush=True)
                break
            time.sleep(1)  # Cek setiap detik
    except KeyboardInterrupt: # Ini seharusnya ditangani oleh signal_handler, tapi sebagai fallback
        signal_handler(None, None)
    finally:
        # Pastikan semua dihentikan saat keluar
        if any(p.poll() is None for p in processes): # Jika masih ada yg jalan
             stop_servers()