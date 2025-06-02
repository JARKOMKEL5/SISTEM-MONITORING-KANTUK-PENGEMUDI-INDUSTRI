# File: Server_Backend/Server.py

import asyncio
import json
import logging
import uuid
import os
from aiohttp import web

logging.basicConfig(level=logging.INFO, format='%(asctime)s [ServerRTC-%(levelname)s] %(message)s')

WEBRTC_SUPERVISORS = set()
WEBRTC_DRIVERS = {} 
WEBRTC_CLIENTS_BY_WS = {}
WEBRTC_CLIENTS_BY_ID = {}
DRIVER_IDS_AVAILABLE = ['Driver1', 'DriverAlpha', 'DriverBeta', 'DriverTest', 'Driver2', 'Driver3']

async def broadcast_to_supervisors(message_dict, exclude_ws=None):
    if WEBRTC_SUPERVISORS:
        active_supervisors = list(WEBRTC_SUPERVISORS) # Salin untuk iterasi aman
        for supervisor_ws in active_supervisors:
            if supervisor_ws == exclude_ws:
                continue
            if not supervisor_ws.closed:
                try:
                    await supervisor_ws.send_json(message_dict)
                except Exception as e:
                    logging.warning(f"Gagal broadcast ke supervisor {WEBRTC_CLIENTS_BY_WS.get(supervisor_ws, 'unknown')}: {type(e).__name__} - {e}")
                    # Pertimbangkan untuk menghapus supervisor jika send gagal berkali-kali, tapi cleanup_client_webrtc akan menanganinya saat close
            else: # Jika sudah ditutup saat iterasi (jarang terjadi jika disalin)
                await cleanup_client_webrtc(supervisor_ws)


async def cleanup_client_webrtc(ws):
    disconnected_identifier = WEBRTC_CLIENTS_BY_WS.pop(ws, None)
    if disconnected_identifier:
        WEBRTC_CLIENTS_BY_ID.pop(disconnected_identifier, None)
        logging.info(f"Klien WebRTC (aiohttp) '{disconnected_identifier}' telah dihapus dari mapping.")

        if ws in WEBRTC_SUPERVISORS:
            WEBRTC_SUPERVISORS.remove(ws)
            logging.info(f"Supervisor WebRTC '{disconnected_identifier}' terputus. Sisa Supervisor: {len(WEBRTC_SUPERVISORS)}")
        
        driver_id_to_remove_from_dict = None
        if disconnected_identifier in WEBRTC_DRIVERS and WEBRTC_DRIVERS.get(disconnected_identifier) == ws:
            driver_id_to_remove_from_dict = disconnected_identifier
        
        if driver_id_to_remove_from_dict:
            if WEBRTC_DRIVERS.get(driver_id_to_remove_from_dict) == ws: # Pastikan ws yang sama
                del WEBRTC_DRIVERS[driver_id_to_remove_from_dict]
                logging.info(f"Driver WebRTC '{driver_id_to_remove_from_dict}' terputus dari daftar DRIVERS. Sisa: {len(WEBRTC_DRIVERS)}")
                await broadcast_to_supervisors({
                    "type": "driver_status_update",
                    "driver_id": driver_id_to_remove_from_dict,
                    "status": "offline"
                })
    else:
        logging.debug(f"Koneksi WebRTC (aiohttp) yang akan di-cleanup tidak memiliki identifier di WEBRTC_CLIENTS_BY_WS atau sudah dibersihkan.")


async def webrtc_aiohttp_handler(request):
    ws = web.WebSocketResponse()
    try:
        await ws.prepare(request)
    except Exception as e_prepare:
        logging.error(f"Gagal WebSocket prepare: {e_prepare}")
        return ws 

    temp_client_id = str(uuid.uuid4())
    WEBRTC_CLIENTS_BY_WS[ws] = temp_client_id
    WEBRTC_CLIENTS_BY_ID[temp_client_id] = ws
    logging.info(f"Klien WebRTC baru terhubung (ID sementara: {temp_client_id}) dari {request.remote}")

    try:
        async for msg in ws:
            if ws.closed: # Cek apakah koneksi sudah ditutup sebelum memproses pesan
                logging.warning(f"Menerima pesan dari koneksi yang sudah ditutup (ID: {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}). Abaikan.")
                break 
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    msg_type = data.get("type")
                    current_client_identifier = WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)
                    logging.debug(f"Menerima pesan dari '{current_client_identifier}': {data}")

                    if msg_type == "register_supervisor":
                        WEBRTC_SUPERVISORS.add(ws)
                        logging.info(f"Supervisor WebRTC '{current_client_identifier}' terdaftar. Total Supervisor: {len(WEBRTC_SUPERVISORS)}")
                        await ws.send_json({"type": "driver_list", "drivers": list(WEBRTC_DRIVERS.keys())})
                    
                    elif msg_type == "register_driver":
                        driver_id = data.get("driver_id")
                        if driver_id and driver_id in DRIVER_IDS_AVAILABLE:
                            if driver_id in WEBRTC_DRIVERS and WEBRTC_DRIVERS[driver_id] != ws and not WEBRTC_DRIVERS[driver_id].closed:
                                await ws.send_json({"type": "error", "message": f"ID Driver '{driver_id}' sudah digunakan."})
                                continue
                            
                            if driver_id in WEBRTC_DRIVERS and WEBRTC_DRIVERS[driver_id].closed:
                                await cleanup_client_webrtc(WEBRTC_DRIVERS[driver_id])

                            if current_client_identifier != driver_id and current_client_identifier in WEBRTC_CLIENTS_BY_ID :
                                del WEBRTC_CLIENTS_BY_ID[current_client_identifier]
                            
                            WEBRTC_DRIVERS[driver_id] = ws
                            WEBRTC_CLIENTS_BY_WS[ws] = driver_id 
                            WEBRTC_CLIENTS_BY_ID[driver_id] = ws
                            
                            logging.info(f"Driver WebRTC '{driver_id}' terdaftar (identifier: '{driver_id}'). Total Driver: {len(WEBRTC_DRIVERS)}")
                            await ws.send_json({"type": "registration_successful", "driver_id": driver_id, "message": f"Driver {driver_id} berhasil terdaftar."})
                            await broadcast_to_supervisors({"type": "driver_status_update","driver_id": driver_id,"status": "online"})
                        else:
                            await ws.send_json({"type": "error", "message": f"ID Driver '{driver_id}' tidak valid atau kosong."})

                    elif msg_type == "webrtc_signal":
                        target_id = data.get("target_id")
                        payload = data.get("payload")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws) 
                        if target_id and payload and sender_id:
                            target_ws = WEBRTC_CLIENTS_BY_ID.get(target_id)
                            if target_ws and not target_ws.closed:
                                logging.info(f"Meneruskan sinyal '{payload.get('type')}' dari '{sender_id}' ke '{target_id}'")
                                await target_ws.send_json({"type": "webrtc_signal", "from_id": sender_id, "payload": payload})
                            else:
                                logging.warning(f"Target WebRTC '{target_id}' tidak online untuk sinyal dari '{sender_id}'.")
                                await ws.send_json({"type":"webrtc_signal_failed", "reason": f"Target '{target_id}' tidak online", "original_payload_type": payload.get("type")})
                        else: logging.warning(f"Pesan webrtc_signal tidak lengkap dari {sender_id or 'unknown'}")
                    
                    elif msg_type == "call_request":
                        target_driver_id = data.get("target_driver_id")
                        supervisor_requesting_id = WEBRTC_CLIENTS_BY_WS.get(ws) 
                        if target_driver_id in WEBRTC_DRIVERS:
                            driver_ws_target = WEBRTC_DRIVERS[target_driver_id]
                            if driver_ws_target and not driver_ws_target.closed:
                                logging.info(f"Supervisor '{supervisor_requesting_id}' meminta panggilan ke Driver '{target_driver_id}'")
                                await driver_ws_target.send_json({"type": "incoming_call", "from_supervisor_id": supervisor_requesting_id})
                            else:
                                await ws.send_json({"type": "call_failed", "reason": f"Driver '{target_driver_id}' offline."})
                                if driver_ws_target: await cleanup_client_webrtc(driver_ws_target)
                        else:
                            await ws.send_json({"type": "call_failed", "reason": f"Driver '{target_driver_id}' tidak ditemukan."})
                    
                    elif msg_type == "cancel_call_attempt": 
                        target_driver_id = data.get("target_driver_id")
                        supervisor_cancelling_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if target_driver_id and supervisor_cancelling_id:
                            logging.info(f"Supervisor '{supervisor_cancelling_id}' membatalkan upaya panggilan ke Driver '{target_driver_id}'")
                            target_ws_driver = WEBRTC_CLIENTS_BY_ID.get(target_driver_id)
                            if target_ws_driver and not target_ws_driver.closed:
                                try:
                                    await target_ws_driver.send_json({
                                        "type": "webrtc_signal", 
                                        "from_id": supervisor_cancelling_id,
                                        "payload": { "type": "call_cancelled_by_supervisor", "reason": "Supervisor membatalkan panggilan."}
                                    })
                                except Exception as e_send_cancel: logging.warning(f"Gagal kirim pembatalan ke {target_driver_id}: {e_send_cancel}")
                        else: logging.warning(f"Pesan cancel_call_attempt tidak valid: {data}")

                    elif msg_type == "driver_drowsy_notification": 
                        driver_id = data.get("driver_id")
                        original_message = data.get("original_opencv_message", "Kantuk terdeteksi!")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if driver_id and sender_id == driver_id: 
                            logging.info(f"Notifikasi kantuk dari Driver '{driver_id}'. Meneruskan ke supervisor...")
                            await broadcast_to_supervisors({"type": "supervisor_drowsiness_alert", "driver_id": driver_id, "message": original_message})
                        else: logging.warning(f"driver_drowsy_notification tidak valid: {data} dari {sender_id}")
                    
                    elif msg_type == "driver_normal_notification": 
                        driver_id = data.get("driver_id")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if driver_id and sender_id == driver_id:
                            logging.info(f"Notifikasi normal dari Driver '{driver_id}'. Meneruskan ke supervisor...")
                            await broadcast_to_supervisors({"type": "supervisor_driver_normal", "driver_id": driver_id, "message": f"Driver {driver_id} kembali normal."})
                        else: logging.warning(f"driver_normal_notification tidak valid: {data} dari {sender_id}")

                except json.JSONDecodeError: logging.error(f"Pesan WS tidak valid: {msg.data}")
                except Exception as e_inner: logging.error(f"Error proses pesan WS: {e_inner}", exc_info=True)
            elif msg.type == web.WSMsgType.ERROR: logging.error(f'Koneksi WS error: {ws.exception()}')
            elif msg.type == web.WSMsgType.CLOSED:
                logging.info(f"Pesan CLOSED diterima dari klien {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}")
                break # Keluar dari loop async for msg
    except asyncio.CancelledError:
        logging.info(f"Task WebSocket untuk {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)} dibatalkan.")
    except Exception as e_outer: 
        logging.warning(f"Error koneksi WS (outer): {type(e_outer).__name__} - {e_outer} untuk {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}")
    finally:
        identifier_at_disconnect = WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)
        logging.info(f"Koneksi WS untuk '{identifier_at_disconnect}' ditutup dari sisi server atau klien.")
        await cleanup_client_webrtc(ws)
    return ws

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
    else: return web.Response(status=404, text=f"Resource {request.path} not found")

async def on_shutdown(app_on_shutdown):
    logging.info("Server shutdown initiated by aiohttp...")
    for ws_conn in list(WEBRTC_CLIENTS_BY_WS.keys()): 
        if not ws_conn.closed: 
            try: await ws_conn.close(code=web.WSCloseCode.GOING_AWAY, message=b'Server shutdown') 
            except Exception: pass
    logging.info("Upaya penutupan koneksi WebRTC aktif selesai.")

async def main():
    app = web.Application()
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
    await site.start()
    logging.info("Server HTTP & WebRTC WS (aiohttp) berjalan di http://0.0.0.0:8080 (Path WS: /ws-webrtc)")
    
    # Cara agar server tetap berjalan sampai dihentikan manual (Ctrl+C)
    # dan memastikan runner.cleanup() dipanggil.
    try:
        while True:
            await asyncio.sleep(3600) # Tidur lama, akan diinterupsi oleh Ctrl+C
    except KeyboardInterrupt:
        logging.info("KeyboardInterrupt diterima, memulai proses shutdown server aiohttp...")
    finally:
        logging.info("Membersihkan runner aiohttp...")
        await runner.cleanup() # Ini akan stop site dan cleanup resource
        logging.info("Runner aiohttp telah dibersihkan.")


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Aplikasi dihentikan (Ctrl+C di __main__).")
    except OSError as e: 
        if (hasattr(e, 'winerror') and e.winerror == 10048) or \
           (hasattr(e, 'errno') and e.errno == 98): # EADDRINUSE
             logging.error(f"FATAL: PORT 8080 SUDAH DIGUNAKAN. Pastikan tidak ada server lain yang berjalan di port ini.")
        else:
            logging.error(f"FATAL: OSError saat memulai server: {e}")
    except Exception as e_main:
        logging.error(f"FATAL: Error tidak terduga di main: {e_main}", exc_info=True)
    finally:
        logging.info("Aplikasi selesai.")