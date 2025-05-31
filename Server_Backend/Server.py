# File: Server_Backend/Server.py

import asyncio
import json
import logging
import uuid
import os
from aiohttp import web

logging.basicConfig(level=logging.INFO)

# Variabel Global untuk koneksi WebRTC via aiohttp
WEBRTC_SUPERVISORS = set()
WEBRTC_DRIVERS = {}  # Format: {driver_id: aiohttp_websocket_response_object}
WEBRTC_CLIENTS_BY_WS = {}
WEBRTC_CLIENTS_BY_ID = {}

# Daftar ID Driver yang diizinkan (contoh)
DRIVER_IDS_AVAILABLE = ['Driver1', 'DriverAlpha', 'DriverBeta', 'DriverTest']


async def cleanup_client_webrtc(ws):
    disconnected_identifier = WEBRTC_CLIENTS_BY_WS.pop(ws, None)
    if disconnected_identifier:
        WEBRTC_CLIENTS_BY_ID.pop(disconnected_identifier, None)
        logging.info(f"Klien WebRTC (aiohttp) {disconnected_identifier} telah dihapus dari mapping.")
        if ws in WEBRTC_SUPERVISORS:
            WEBRTC_SUPERVISORS.remove(ws)
            logging.info(f"Supervisor WebRTC {disconnected_identifier} terputus. Sisa: {len(WEBRTC_SUPERVISORS)}")
        if disconnected_identifier in WEBRTC_DRIVERS and WEBRTC_DRIVERS.get(disconnected_identifier) == ws:
            del WEBRTC_DRIVERS[disconnected_identifier]
            logging.info(f"Driver WebRTC {disconnected_identifier} terputus dari daftar. Sisa: {len(WEBRTC_DRIVERS)}")
            for supervisor_ws in list(WEBRTC_SUPERVISORS):
                if not supervisor_ws.closed:
                    try:
                        await supervisor_ws.send_json({
                            "type": "driver_status_update",
                            "driver_id": disconnected_identifier,
                            "status": "offline"
                        })
                    except Exception as e_bcast_final:
                        logging.warning(f"Gagal broadcast disconnect driver {disconnected_identifier}: {e_bcast_final}")
    else:
        logging.debug(f"Koneksi WebRTC (aiohttp) yang tidak teridentifikasi/sudah dibersihkan, terputus.")


async def webrtc_aiohttp_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    temp_client_id = str(uuid.uuid4())
    WEBRTC_CLIENTS_BY_WS[ws] = temp_client_id
    WEBRTC_CLIENTS_BY_ID[temp_client_id] = ws
    logging.info(f"Klien WebRTC baru terhubung (ID sementara: {temp_client_id}) dari {request.remote}")

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    msg_type = data.get("type")
                    current_client_identifier = WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)
                    logging.debug(f"Menerima pesan dari '{current_client_identifier}': {data}")

                    if msg_type == "register_supervisor":
                        WEBRTC_SUPERVISORS.add(ws)
                        logging.info(f"Supervisor WebRTC '{current_client_identifier}' terdaftar. Total: {len(WEBRTC_SUPERVISORS)}")
                        await ws.send_json({"type": "driver_list", "drivers": list(WEBRTC_DRIVERS.keys())})
                    
                    elif msg_type == "register_driver":
                        driver_id = data.get("driver_id")
                        if driver_id and driver_id in DRIVER_IDS_AVAILABLE: # Pastikan driver_id tidak kosong
                            if driver_id in WEBRTC_DRIVERS and WEBRTC_DRIVERS[driver_id] != ws and not WEBRTC_DRIVERS[driver_id].closed:
                                await ws.send_json({"type": "error", "message": f"ID Driver '{driver_id}' sudah digunakan."})
                                continue
                            if current_client_identifier in WEBRTC_CLIENTS_BY_ID: del WEBRTC_CLIENTS_BY_ID[current_client_identifier]
                            WEBRTC_DRIVERS[driver_id] = ws
                            WEBRTC_CLIENTS_BY_WS[ws] = driver_id
                            WEBRTC_CLIENTS_BY_ID[driver_id] = ws
                            logging.info(f"Driver WebRTC '{driver_id}' terdaftar (sebelumnya '{current_client_identifier}'). Total: {len(WEBRTC_DRIVERS)}")
                            try:
                                await ws.send_json({"type": "registration_successful", "driver_id": driver_id, "message": f"Driver {driver_id} berhasil terdaftar."})
                            except Exception as e_send_confirm: logging.error(f"Gagal kirim konfirmasi ke {driver_id}: {e_send_confirm}")
                            for supervisor_ws in list(WEBRTC_SUPERVISORS):
                                if not supervisor_ws.closed:
                                    try: await supervisor_ws.send_json({"type": "driver_status_update","driver_id": driver_id,"status": "online"})
                                    except Exception: pass
                        else:
                            await ws.send_json({"type": "error", "message": f"ID Driver '{driver_id}' tidak valid atau kosong."})

                    elif msg_type == "webrtc_signal":
                        target_id = data.get("target_id")
                        payload = data.get("payload")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if target_id and payload and sender_id:
                            target_ws = WEBRTC_CLIENTS_BY_ID.get(target_id)
                            if target_ws and not target_ws.closed:
                                await target_ws.send_json({"type": "webrtc_signal", "from_id": sender_id, "payload": payload})
                            else:
                                await ws.send_json({"type":"webrtc_signal_failed", "reason": f"Target '{target_id}' tidak online", "original_payload_type": payload.get("type")})
                        else: logging.warning(f"Pesan webrtc_signal tidak lengkap dari {sender_id or 'unknown'}")
                    
                    elif msg_type == "call_request":
                        target_driver_id = data.get("target_driver_id")
                        supervisor_requesting_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if target_driver_id in WEBRTC_DRIVERS:
                            driver_ws_target = WEBRTC_DRIVERS[target_driver_id]
                            if driver_ws_target and not driver_ws_target.closed:
                                await driver_ws_target.send_json({"type": "incoming_call", "from_supervisor_id": supervisor_requesting_id})
                            else:
                                await ws.send_json({"type": "call_failed", "reason": f"Driver '{target_driver_id}' offline."})
                                if driver_ws_target: await cleanup_client_webrtc(driver_ws_target)
                        else:
                            await ws.send_json({"type": "call_failed", "reason": f"Driver '{target_driver_id}' tidak ditemukan."})
                    
                    elif msg_type == "driver_drowsy_notification": # BARU
                        driver_id = data.get("driver_id")
                        original_message = data.get("original_opencv_message", "Kantuk terdeteksi!")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if driver_id and sender_id == driver_id:
                            logging.info(f"Notifikasi kantuk dari Driver '{driver_id}'. Meneruskan ke supervisor...")
                            for supervisor_ws in list(WEBRTC_SUPERVISORS):
                                if not supervisor_ws.closed:
                                    try:
                                        await supervisor_ws.send_json({
                                            "type": "supervisor_drowsiness_alert",
                                            "driver_id": driver_id,
                                            "message": original_message
                                        })
                                    except Exception as e_bcast_drowsy: logging.warning(f"Gagal broadcast notifikasi kantuk: {e_bcast_drowsy}")
                        else: logging.warning(f"driver_drowsy_notification tidak valid: {data} dari {sender_id}")
                    
                    elif msg_type == "driver_normal_notification": # BARU
                        driver_id = data.get("driver_id")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if driver_id and sender_id == driver_id:
                            logging.info(f"Notifikasi kondisi normal dari Driver '{driver_id}'. Meneruskan ke supervisor...")
                            for supervisor_ws in list(WEBRTC_SUPERVISORS):
                                if not supervisor_ws.closed:
                                    try:
                                        await supervisor_ws.send_json({
                                            "type": "supervisor_driver_normal",
                                            "driver_id": driver_id,
                                            "message": f"Driver {driver_id} kembali ke kondisi normal."
                                        })
                                    except Exception as e_bcast_normal: logging.warning(f"Gagal broadcast notifikasi normal: {e_bcast_normal}")
                        else: logging.warning(f"driver_normal_notification tidak valid: {data} dari {sender_id}")

                except json.JSONDecodeError: logging.error(f"Pesan WS tidak valid: {msg.data}")
                except Exception as e_inner: logging.error(f"Error proses pesan WS: {e_inner}", exc_info=True)
            elif msg.type == web.WSMsgType.ERROR: logging.error(f'Koneksi WS error: {ws.exception()}')
    except Exception as e_outer: logging.warning(f"Error koneksi WS: {type(e_outer).__name__} - {e_outer}")
    finally:
        logging.info(f"Koneksi WS untuk {WEBRTC_CLIENTS_BY_WS.get(ws, 'akan dihapus')} ditutup...")
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
    else: return web.Response(status=404, text=f"Resource {request.path} not found")

async def on_shutdown(app_on_shutdown):
    logging.info("Server shutdown...")
    for ws_conn in list(WEBRTC_CLIENTS_BY_WS.keys()): 
        if not ws_conn.closed: await ws_conn.close(code=1001, message=b'Server shutdown') 
    logging.info("Koneksi WebRTC ditutup.")

async def main():
    app = web.Application()
    app.router.add_get('/', serve_html_js_asset)
    app.router.add_get('/supervisor', serve_html_js_asset)
    app.router.add_get('/driver', serve_html_js_asset)
    app.router.add_get('/assets/supervisor.js', serve_html_js_asset)
    app.router.add_get('/assets/driver.js', serve_html_js_asset)
    app.router.add_get('/ws-webrtc', webrtc_aiohttp_handler)
    app.on_shutdown.append(on_shutdown)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', 8080)
    await site.start()
    logging.info("Server HTTP & WebRTC WS (aiohttp) berjalan di http://0.0.0.0:8080 (Path WS: /ws-webrtc)")
    try: await asyncio.Future() 
    except KeyboardInterrupt: logging.info("KeyboardInterrupt...")
    finally: logging.info("Menghentikan server...")

if __name__ == '__main__':
    try: asyncio.run(main())
    except KeyboardInterrupt: logging.info("Aplikasi dihentikan (Ctrl+C di __main__).")
    finally: logging.info("Aplikasi selesai.")