# File: Server_Backend/Server.py
# (Bagian import dan variabel global sama seperti yang Anda berikan)
import asyncio
import json
import logging
import uuid
import os
from aiohttp import web

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s-%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
logger = logging.getLogger("ServerRTC")

WEBRTC_SUPERVISORS = set()
WEBRTC_DRIVERS = {}
WEBRTC_CLIENTS_BY_WS = {}
WEBRTC_CLIENTS_BY_ID = {}
DRIVER_IDS_AVAILABLE = ['Driver1', 'Driver2', 'Driver3', 'Driver4', 'Driver5', 'Driver6', 'DriverAlpha', 'DriverBeta', 'DriverTest']


async def broadcast_to_supervisors(message_dict, exclude_ws=None):
    # ... (Fungsi ini sepertinya sudah cukup baik, mungkin tambahkan pengecekan ws.closed sebelum send_json) ...
    if WEBRTC_SUPERVISORS:
        current_supervisors = list(WEBRTC_SUPERVISORS) 
        for supervisor_ws in current_supervisors:
            if supervisor_ws == exclude_ws:
                continue
            if not supervisor_ws.closed:
                try:
                    await supervisor_ws.send_json(message_dict)
                except Exception as e:
                    logger.warning(f"Gagal broadcast ke supervisor {WEBRTC_CLIENTS_BY_WS.get(supervisor_ws, 'unknown')}: {type(e).__name__} - {e}")
                    # Jika gagal kirim, anggap koneksi bermasalah dan bersihkan
                    # Ini bisa agresif, tapi membantu menjaga state tetap bersih
                    await cleanup_client_webrtc(supervisor_ws) 
            else: 
                if supervisor_ws in WEBRTC_SUPERVISORS : 
                     WEBRTC_SUPERVISORS.remove(supervisor_ws) # Hapus langsung jika sudah ditutup
                # Panggil cleanup untuk membersihkan mapping lain jika belum
                if WEBRTC_CLIENTS_BY_WS.get(supervisor_ws): # Hanya panggil jika masih ada di map utama
                    await cleanup_client_webrtc(supervisor_ws)


async def cleanup_client_webrtc(ws_to_cleanup):
    if ws_to_cleanup is None:
        logger.warning("CLEANUP: dipanggil dengan objek ws None.")
        return

    logger.info(f"CLEANUP: Memulai pembersihan untuk objek ws id: {id(ws_to_cleanup)}")
    disconnected_identifier = WEBRTC_CLIENTS_BY_WS.pop(ws_to_cleanup, None)
    
    if disconnected_identifier:
        # Hapus dari mapping ID ke WS jika identifiernya ada dan menunjuk ke ws yang sama
        if WEBRTC_CLIENTS_BY_ID.get(disconnected_identifier) == ws_to_cleanup:
            WEBRTC_CLIENTS_BY_ID.pop(disconnected_identifier, None)
        logger.info(f"CLEANUP: Klien WebRTC '{disconnected_identifier}' dihapus dari mapping utama (by_ws & by_id).")

        if ws_to_cleanup in WEBRTC_SUPERVISORS:
            WEBRTC_SUPERVISORS.discard(ws_to_cleanup)
            logger.info(f"CLEANUP: Supervisor WebRTC '{disconnected_identifier}' terputus/dihapus. Sisa: {len(WEBRTC_SUPERVISORS)}")
        
        # Periksa apakah identifier yang terputus adalah driver_id yang terdaftar di WEBRTC_DRIVERS
        # dan pastikan objek ws-nya sama persis sebelum menghapus.
        if disconnected_identifier in WEBRTC_DRIVERS and WEBRTC_DRIVERS.get(disconnected_identifier) == ws_to_cleanup:
            del WEBRTC_DRIVERS[disconnected_identifier]
            logger.info(f"CLEANUP: Driver WebRTC '{disconnected_identifier}' terputus/dihapus dari daftar DRIVERS. Sisa: {len(WEBRTC_DRIVERS)}")
            await broadcast_to_supervisors({
                "type": "driver_status_update",
                "driver_id": disconnected_identifier,
                "status": "offline"
            })
        # Log tambahan jika identifier ada di CLIENTS_BY_ID tapi tidak di DRIVERS (misal, supervisor)
        elif disconnected_identifier not in WEBRTC_DRIVERS and disconnected_identifier not in WEBRTC_SUPERVISORS:
             logger.info(f"CLEANUP: Klien WebRTC '{disconnected_identifier}' (bukan supervisor terdaftar atau driver aktif) dibersihkan.")
    else:
        # Mungkin ws_to_cleanup sudah pernah di-cleanup, atau tidak pernah terdaftar di WEBRTC_CLIENTS_BY_WS
        # Coba cari berdasarkan objek ws di dictionary lain jika perlu, tapi biasanya pop(ws, None) sudah cukup
        logger.debug(f"CLEANUP: Objek ws {id(ws_to_cleanup)} tidak ditemukan di WEBRTC_CLIENTS_BY_WS (mungkin sudah dibersihkan).")


async def webrtc_aiohttp_handler(request):
    ws = web.WebSocketResponse()
    try:
        await ws.prepare(request)
    except Exception as e_prepare:
        logger.error(f"Gagal WebSocket prepare: {e_prepare}")
        return ws 

    temp_client_id = str(uuid.uuid4()) # ID unik sementara untuk setiap koneksi WebSocket
    WEBRTC_CLIENTS_BY_WS[ws] = temp_client_id
    WEBRTC_CLIENTS_BY_ID[temp_client_id] = ws
    logger.info(f"Klien WebRTC baru terhubung (ID sementara: {temp_client_id}) dari {request.remote} (objek ws: {id(ws)})")

    try:
        async for msg in ws:
            if ws.closed: 
                logger.warning(f"Menerima pesan dari koneksi yang sudah ditutup (ID: {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}). Loop dihentikan.")
                break 
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    msg_type = data.get("type")
                    current_client_identifier = WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id) 
                    logger.debug(f"Pesan dari '{current_client_identifier}' (ws: {id(ws)}): {data}")

                    if msg_type == "register_supervisor":
                        # Jika supervisor ini sebelumnya adalah driver dengan koneksi ws yang sama, bersihkan status drivernya.
                        if current_client_identifier in WEBRTC_DRIVERS and WEBRTC_DRIVERS.get(current_client_identifier) == ws:
                            logger.info(f"Supervisor '{current_client_identifier}' sebelumnya adalah driver. Membersihkan status driver.")
                            del WEBRTC_DRIVERS[current_client_identifier] # Hapus dari driver
                            # WEBRTC_CLIENTS_BY_ID[current_client_identifier] akan tetap menunjuk ke ws ini
                            # WEBRTC_CLIENTS_BY_WS[ws] akan tetap current_client_identifier
                            await broadcast_to_supervisors({"type": "driver_status_update", "driver_id": current_client_identifier, "status": "offline"})
                        
                        WEBRTC_SUPERVISORS.add(ws)
                        # Supervisor diidentifikasi oleh current_client_identifier (bisa UUID jika belum pernah jadi driver)
                        logger.info(f"Supervisor WebRTC '{current_client_identifier}' terdaftar. Total Supervisor: {len(WEBRTC_SUPERVISORS)}")
                        online_drivers = [driver_id for driver_id, driver_ws_obj in WEBRTC_DRIVERS.items() if driver_ws_obj and not driver_ws_obj.closed]
                        await ws.send_json({"type": "driver_list", "drivers": online_drivers})
                    
                    elif msg_type == "register_driver":
                        driver_id_to_register = data.get("driver_id")
                        logger.info(f"Proses registrasi untuk Driver ID: '{driver_id_to_register}' dari klien '{current_client_identifier}' (objek ws: {id(ws)})")

                        if driver_id_to_register and driver_id_to_register in DRIVER_IDS_AVAILABLE:
                            # 1. Cek apakah ID driver ini sudah digunakan oleh koneksi ws AKTIF LAIN
                            if driver_id_to_register in WEBRTC_DRIVERS and \
                               WEBRTC_DRIVERS[driver_id_to_register] != ws and \
                               not WEBRTC_DRIVERS[driver_id_to_register].closed:
                                logger.warning(f"Driver ID '{driver_id_to_register}' sudah digunakan oleh koneksi aktif lain. Menolak '{current_client_identifier}'.")
                                await ws.send_json({"type": "error", "message": f"ID Driver '{driver_id_to_register}' sudah digunakan oleh sesi lain."})
                                continue 
                            
                            # 2. Jika ID driver ini ada di WEBRTC_DRIVERS (mungkin dengan ws yang sama atau ws lama yang mati)
                            # atau jika koneksi ws ini sebelumnya adalah supervisor
                            # Kita perlu membersihkan state lama sebelum mendaftarkan yang baru.

                            # Jika ws ini sebelumnya adalah supervisor, hapus dari supervisor set
                            if ws in WEBRTC_SUPERVISORS:
                                WEBRTC_SUPERVISORS.discard(ws)
                                logger.info(f"Klien '{current_client_identifier}' (sebelumnya supervisor) kini menjadi driver '{driver_id_to_register}'.")
                            
                            # Jika ID driver ini sudah ada di WEBRTC_DRIVERS (mungkin dengan ws lama yang mati atau bahkan ws ini sendiri jika re-register)
                            if driver_id_to_register in WEBRTC_DRIVERS:
                                old_ws_for_this_driver_id = WEBRTC_DRIVERS[driver_id_to_register]
                                if old_ws_for_this_driver_id != ws: # Jika ws nya beda, berarti ID ini dipakai koneksi lain (yang mungkin mati)
                                    logger.info(f"Membersihkan koneksi lama (ws id: {id(old_ws_for_this_driver_id)}) untuk Driver ID '{driver_id_to_register}' sebelum registrasi baru dengan ws id: {id(ws)}.")
                                    await cleanup_client_webrtc(old_ws_for_this_driver_id)
                            
                            # 3. Bersihkan mapping ID sementara (UUID) untuk koneksi ws ini, karena akan diganti driver_id
                            if current_client_identifier != driver_id_to_register and current_client_identifier in WEBRTC_CLIENTS_BY_ID:
                                # Pastikan tidak menghapus jika current_client_identifier adalah driver_id lain yang valid
                                if WEBRTC_CLIENTS_BY_ID.get(current_client_identifier) == ws :
                                     logger.info(f"Menghapus identifier lama '{current_client_identifier}' dari CLIENTS_BY_ID karena akan diganti '{driver_id_to_register}' untuk ws {id(ws)}.")
                                     del WEBRTC_CLIENTS_BY_ID[current_client_identifier]
                            
                            # 4. Daftarkan driver dengan koneksi ws saat ini
                            WEBRTC_DRIVERS[driver_id_to_register] = ws
                            WEBRTC_CLIENTS_BY_WS[ws] = driver_id_to_register 
                            WEBRTC_CLIENTS_BY_ID[driver_id_to_register] = ws 
                            
                            logger.info(f"✓ Driver WebRTC '{driver_id_to_register}' terdaftar dengan ws {id(ws)}. Total: {len(WEBRTC_DRIVERS)}")
                            await ws.send_json({"type": "registration_successful", "driver_id": driver_id_to_register, "message": f"Driver {driver_id_to_register} berhasil terdaftar."})
                            await broadcast_to_supervisors({"type": "driver_status_update","driver_id": driver_id_to_register,"status": "online"})
                        else:
                            await ws.send_json({"type": "error", "message": f"ID Driver '{driver_id_to_register}' tidak valid atau kosong."})

                    elif msg_type == "webrtc_signal":
                        target_id = data.get("target_id")
                        payload = data.get("payload")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws) 
                        
                        logger.info(f"=== WEBRTC SIGNAL DEBUG (dari Server) ===")
                        logger.info(f"Sender: '{sender_id}' (ws: {id(ws)}), Target: '{target_id}', Payload Type: {payload.get('type') if payload else 'N/A'}")
                        
                        target_ws = WEBRTC_CLIENTS_BY_ID.get(target_id) # Ini yang paling penting untuk lookup
                        logger.info(f"Mencari target '{target_id}' di CLIENTS_BY_ID. Objek WS ditemukan: {bool(target_ws)} (ws id: {id(target_ws) if target_ws else 'None'})")
                        if target_ws: logger.info(f"Koneksi WS target '{target_id}' closed: {target_ws.closed}")

                        if target_ws and not target_ws.closed:
                            logger.info(f"✓ Meneruskan sinyal '{payload.get('type')}' dari '{sender_id}' ke '{target_id}'")
                            await target_ws.send_json({"type": "webrtc_signal", "from_id": sender_id, "payload": payload})
                        else:
                            logger.warning(f"✗ Target WebRTC '{target_id}' tidak online/valid untuk sinyal dari '{sender_id}'.")
                            await ws.send_json({"type":"webrtc_signal_failed", "reason": f"Target '{target_id}' tidak online", "original_payload_type": payload.get("type")})
                    
                    # ... (sisa case: call_request, cancel_call_attempt, driver_drowsy_notification, driver_normal_notification, ping, debug_state)
                    # Pastikan lookup untuk driver_ws_target di call_request menggunakan WEBRTC_DRIVERS.get(target_driver_id)
                    # dan kemudian cek .closed
                    elif msg_type == "call_request":
                        target_driver_id = data.get("target_driver_id")
                        supervisor_requesting_id = WEBRTC_CLIENTS_BY_WS.get(ws) 
                        
                        logger.info(f"Call request dari Supervisor '{supervisor_requesting_id}' ke Driver '{target_driver_id}'")
                        driver_ws_target = WEBRTC_DRIVERS.get(target_driver_id) 
                        
                        if driver_ws_target and not driver_ws_target.closed:
                            logger.info(f"✓ Driver '{target_driver_id}' ditemukan dan online. Mengirim incoming_call...")
                            await driver_ws_target.send_json({"type": "incoming_call", "from_supervisor_id": supervisor_requesting_id})
                        else:
                            logger.warning(f"✗ Driver '{target_driver_id}' tidak online atau tidak ditemukan saat call_request.")
                            await ws.send_json({"type": "call_failed", "reason": f"Driver '{target_driver_id}' tidak online atau tidak ditemukan."})
                            if driver_ws_target and driver_ws_target.closed: # Jika ada tapi closed
                                await cleanup_client_webrtc(driver_ws_target)
                    
                    elif msg_type == "cancel_call_attempt": 
                        target_driver_id = data.get("target_driver_id")
                        supervisor_cancelling_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if target_driver_id and supervisor_cancelling_id:
                            logger.info(f"Supervisor '{supervisor_cancelling_id}' membatalkan upaya panggilan ke Driver '{target_driver_id}'")
                            target_ws_driver = WEBRTC_CLIENTS_BY_ID.get(target_driver_id)
                            if target_ws_driver and not target_ws_driver.closed:
                                try:
                                    await target_ws_driver.send_json({
                                        "type": "webrtc_signal", 
                                        "from_id": supervisor_cancelling_id,
                                        "payload": { "type": "call_cancelled_by_supervisor", "reason": "Supervisor membatalkan panggilan."}
                                    })
                                except Exception as e_send_cancel: logger.warning(f"Gagal kirim pembatalan ke {target_driver_id}: {e_send_cancel}")
                        else: logging.warning(f"Pesan cancel_call_attempt tidak valid: {data}")

                    elif msg_type == "driver_drowsy_notification": 
                        driver_id = data.get("driver_id")
                        original_message = data.get("original_opencv_message", "Kantuk terdeteksi!")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if driver_id and sender_id == driver_id: 
                            logger.info(f"Notifikasi kantuk dari Driver '{driver_id}'. Meneruskan ke supervisor...")
                            await broadcast_to_supervisors({"type": "supervisor_drowsiness_alert", "driver_id": driver_id, "message": original_message})
                        else: logging.warning(f"driver_drowsy_notification tidak valid: {data} dari {sender_id}")
                    
                    elif msg_type == "driver_normal_notification": 
                        driver_id = data.get("driver_id")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if driver_id and sender_id == driver_id:
                            logger.info(f"Notifikasi normal dari Driver '{driver_id}'. Meneruskan ke supervisor...")
                            await broadcast_to_supervisors({"type": "supervisor_driver_normal", "driver_id": driver_id, "message": f"Driver {driver_id} kembali normal."})
                        else: logging.warning(f"driver_normal_notification tidak valid: {data} dari {sender_id}")
                    
                    elif msg_type == "ping":
                        await ws.send_json({"type": "pong"})
                    
                    elif msg_type == "debug_state":
                        debug_info = {
                            "type": "debug_response",
                            "WEBRTC_DRIVERS": {k: id(v) for k, v in WEBRTC_DRIVERS.items()},
                            "WEBRTC_CLIENTS_BY_ID": {k: id(v) for k, v in WEBRTC_CLIENTS_BY_ID.items()},
                            "WEBRTC_CLIENTS_BY_WS": {id(k): v for k, v in WEBRTC_CLIENTS_BY_WS.items()},
                            "WEBRTC_SUPERVISORS_COUNT": len(WEBRTC_SUPERVISORS),
                            "SENDER_ID": WEBRTC_CLIENTS_BY_WS.get(ws, "unknown")
                        }
                        await ws.send_json(debug_info)
                        logger.info(f"Debug state sent to {WEBRTC_CLIENTS_BY_WS.get(ws, 'unknown')}: {debug_info}")
                    
                    else:
                        logger.warning(f"Tipe pesan tidak dikenal: '{msg_type}' dari {current_client_identifier}")


                except json.JSONDecodeError: logging.error(f"Pesan WS tidak valid JSON: {msg.data}")
                except Exception as e_inner: logging.error(f"Error proses pesan WS dari '{current_client_identifier}': {e_inner}", exc_info=True)
            
            elif msg.type == web.WSMsgType.ERROR: 
                logging.error(f'Koneksi WS error untuk {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}: {ws.exception()}')
                break 
            
            elif msg.type == web.WSMsgType.CLOSED:
                logging.info(f"Pesan CLOSED diterima dari klien {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}")
                break 
    
    except asyncio.CancelledError:
        logging.info(f"Task WebSocket untuk {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)} dibatalkan.")
    except Exception as e_outer: 
        logging.warning(f"Error koneksi WS (outer loop): {type(e_outer).__name__} - {e_outer} untuk {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}")
    finally:
        identifier_at_disconnect = WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id) 
        logging.info(f"Koneksi WS untuk '{identifier_at_disconnect}' akan ditutup/dibersihkan...")
        await cleanup_client_webrtc(ws)
    
    return ws

# ... (fungsi serve_html_js_asset, on_shutdown, main, if __name__ == '__main__': SAMA seperti sebelumnya)
# Saya akan sertakan lagi untuk kelengkapan:

async def serve_html_js_asset(request):
    server_backend_dir = os.path.dirname(os.path.abspath(__file__))
    project_root_dir = os.path.abspath(os.path.join(server_backend_dir, '..'))
    filepath = None; path = request.path
    if path == "/" or path == "/supervisor": filepath = os.path.join(project_root_dir, 'Client_Supervisor', 'Supervisor.html')
    elif path == "/driver": filepath = os.path.join(project_root_dir, 'Client_Driver', 'templates', 'Driver.html')
    elif path == "/assets/supervisor.js": filepath = os.path.join(project_root_dir, 'Client_Supervisor', 'Supervisor.js')
    elif path == "/assets/driver.js": filepath = os.path.join(project_root_dir, 'Client_Driver', 'Driver.js')
    if filepath and os.path.exists(filepath): return web.FileResponse(filepath)
    elif path == "/favicon.ico": return web.Response(status=204) 
    else: 
        logger.warning(f"Resource tidak ditemukan: {request.path}")
        return web.Response(status=404, text=f"Resource {request.path} not found")

async def on_shutdown(app_on_shutdown):
    logger.info("Memulai proses shutdown server...")
    active_clients = list(WEBRTC_CLIENTS_BY_WS.keys()) 
    for ws_conn in active_clients: 
        if not ws_conn.closed: 
            try: await ws_conn.close(code=web.WSCloseCode.GOING_AWAY, message=b'Server shutdown') 
            except Exception: pass
    logger.info("Semua upaya penutupan koneksi WebRTC aktif selesai.")

async def main():
    app = web.Application(logger=logger) 
    app.router.add_get('/', serve_html_js_asset)
    app.router.add_get('/supervisor', serve_html_js_asset)
    app.router.add_get('/driver', serve_html_js_asset)
    app.router.add_get('/assets/supervisor.js', serve_html_js_asset)
    app.router.add_get('/assets/driver.js', serve_html_js_asset)
    app.router.add_get('/favicon.ico', serve_html_js_asset) 
    app.router.add_get('/ws-webrtc', webrtc_aiohttp_handler)
    
    app.on_shutdown.append(on_shutdown)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', 8080)
    try:
        await site.start()
        logger.info("Server HTTP & WebRTC WS (aiohttp) berjalan di http://0.0.0.0:8080 (Path WS: /ws-webrtc)")
        while True:
            await asyncio.sleep(3600) 
    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt diterima, memulai proses shutdown server aiohttp...")
    except OSError as e: 
        if hasattr(e, 'winerror') and e.winerror == 10048 or (hasattr(e, 'errno') and e.errno == 98):
             logger.error(f"FATAL: PORT 8080 SUDAH DIGUNAKAN.")
        else:
            logger.error(f"FATAL: OSError saat site.start() atau loop utama: {e}")
    except Exception as e_main_loop:
        logger.error(f"FATAL: Error tidak terduga di loop utama server: {e_main_loop}", exc_info=True)
    finally:
        logger.info("Membersihkan runner aiohttp...")
        # Site stop dan runner cleanup akan dipanggil secara otomatis saat keluar dari blok try 
        # jika asyncio.run(main()) digunakan dan loop event berhenti.
        # Namun, untuk lebih eksplisit dengan loop while True:
        await site.stop()
        await runner.cleanup() 
        logger.info("Runner aiohttp telah dibersihkan.")

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Aplikasi dihentikan (Ctrl+C di __main__).")
    finally:
        logger.info("Aplikasi selesai.")