# File: Server_Backend/Server.py

import asyncio
import json
import logging
import uuid
import os
import time
from aiohttp import web

logging.basicConfig(
    level=logging.INFO, 
    format='%(asctime)s [%(name)s-%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("ServerRTC")

WEBRTC_SUPERVISORS = set()
WEBRTC_DRIVERS = {} 
WEBRTC_CLIENTS_BY_WS = {}
WEBRTC_CLIENTS_BY_ID = {}
DRIVER_IDS_AVAILABLE = ['Driver1', 'DriverAlpha', 'DriverBeta', 'DriverTest', 'Driver2', 'Driver3']

async def broadcast_to_supervisors(message_dict, exclude_ws=None):
    if WEBRTC_SUPERVISORS:
        current_supervisors = list(WEBRTC_SUPERVISORS) 
        for supervisor_ws in current_supervisors:
            if supervisor_ws == exclude_ws or supervisor_ws.closed:
                if supervisor_ws.closed and supervisor_ws in WEBRTC_SUPERVISORS : 
                     WEBRTC_SUPERVISORS.remove(supervisor_ws)
                continue
            try:
                await supervisor_ws.send_json(message_dict)
            except ConnectionResetError:
                logger.warning(f"Gagal broadcast ke supervisor (ConnectionResetError): {WEBRTC_CLIENTS_BY_WS.get(supervisor_ws, 'unknown')}")
            except Exception as e:
                logger.warning(f"Gagal broadcast ke supervisor {WEBRTC_CLIENTS_BY_WS.get(supervisor_ws, 'unknown')}: {type(e).__name__} - {e}")

async def cleanup_client_webrtc(ws_to_cleanup):
    if ws_to_cleanup is None:
        logger.warning("CLEANUP: dipanggil dengan objek ws None.")
        return

    logger.info(f"CLEANUP: Memulai pembersihan untuk objek ws id: {id(ws_to_cleanup)}")
    # Dapatkan identifier sebelum menghapus dari WEBRTC_CLIENTS_BY_WS
    disconnected_identifier = WEBRTC_CLIENTS_BY_WS.get(ws_to_cleanup) 
    
    # Hapus dari WEBRTC_CLIENTS_BY_WS terlebih dahulu
    if ws_to_cleanup in WEBRTC_CLIENTS_BY_WS:
        del WEBRTC_CLIENTS_BY_WS[ws_to_cleanup]

    if disconnected_identifier:
        # Hapus dari mapping ID ke WS jika identifiernya ada dan menunjuk ke ws yang sama
        if WEBRTC_CLIENTS_BY_ID.get(disconnected_identifier) == ws_to_cleanup:
            del WEBRTC_CLIENTS_BY_ID[disconnected_identifier]
        logger.info(f"CLEANUP: Klien WebRTC '{disconnected_identifier}' telah dihapus dari mapping utama (by_ws & by_id).")

        if ws_to_cleanup in WEBRTC_SUPERVISORS:
            WEBRTC_SUPERVISORS.discard(ws_to_cleanup)
            logger.info(f"CLEANUP: Supervisor WebRTC '{disconnected_identifier}' terputus/dihapus. Sisa Supervisor: {len(WEBRTC_SUPERVISORS)}")
        
        # Hapus dari WEBRTC_DRIVERS jika ws yang terputus adalah ws yang terdaftar untuk driver_id tersebut
        if disconnected_identifier in WEBRTC_DRIVERS and WEBRTC_DRIVERS.get(disconnected_identifier) == ws_to_cleanup:
            del WEBRTC_DRIVERS[disconnected_identifier]
            logger.info(f"CLEANUP: Driver WebRTC '{disconnected_identifier}' terputus/dihapus dari daftar DRIVERS. Sisa: {len(WEBRTC_DRIVERS)}")
            await broadcast_to_supervisors({
                "type": "driver_status_update",
                "driver_id": disconnected_identifier,
                "status": "offline"
            })
    else:
        # Jika tidak ada di WEBRTC_CLIENTS_BY_WS, mungkin sudah di-cleanup atau tidak pernah terdaftar penuh
        logger.debug(f"CLEANUP: Objek ws {id(ws_to_cleanup)} tidak ditemukan di WEBRTC_CLIENTS_BY_WS saat awal cleanup (mungkin sudah dibersihkan).")

async def get_active_drivers_status():
    """Helper function to get current status of all drivers"""
    status = {}
    for driver_id in DRIVER_IDS_AVAILABLE:
        driver_ws = WEBRTC_DRIVERS.get(driver_id)
        if driver_ws and not driver_ws.closed:
            status[driver_id] = "online"
        else:
            status[driver_id] = "offline"
    return status

async def validate_and_cleanup_drivers():
    """Validate all drivers and cleanup disconnected ones"""
    drivers_to_cleanup = []
    for driver_id, driver_ws in WEBRTC_DRIVERS.items():
        if driver_ws.closed:
            drivers_to_cleanup.append((driver_id, driver_ws))
    
    for driver_id, driver_ws in drivers_to_cleanup:
        logger.info(f"Membersihkan driver terputus: {driver_id}")
        await cleanup_client_webrtc(driver_ws)

async def webrtc_aiohttp_handler(request):
    ws = web.WebSocketResponse()
    try:
        await ws.prepare(request)
    except Exception as e_prepare:
        logger.error(f"Gagal WebSocket prepare: {e_prepare}")
        return ws 

    temp_client_id = str(uuid.uuid4()) 
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
                    current_ws_identifier = WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id) 
                    logger.debug(f"Pesan dari '{current_ws_identifier}' (ws: {id(ws)}): {data}")

                    if msg_type == "register_supervisor":
                        # Jika ws ini sebelumnya adalah driver, bersihkan status drivernya.
                        if current_ws_identifier in WEBRTC_DRIVERS and WEBRTC_DRIVERS.get(current_ws_identifier) == ws:
                            logger.info(f"Klien '{current_ws_identifier}' (sebelumnya driver) kini menjadi supervisor. Menghapus dari daftar driver.")
                            del WEBRTC_DRIVERS[current_ws_identifier] 
                            await broadcast_to_supervisors({"type": "driver_status_update", "driver_id": current_ws_identifier, "status": "offline"})
                        
                        WEBRTC_SUPERVISORS.add(ws)
                        logger.info(f"Supervisor WebRTC '{current_ws_identifier}' terdaftar. Total Supervisor: {len(WEBRTC_SUPERVISORS)}")
                        
                        # Send current driver status to the new supervisor
                        await validate_and_cleanup_drivers()  # Clean up any disconnected drivers first
                        driver_status = await get_active_drivers_status()
                        online_drivers = [driver_id for driver_id, status in driver_status.items() if status == "online"]
                        await ws.send_json({"type": "driver_list", "drivers": online_drivers})
                        
                        # Send detailed status for each driver
                        for driver_id, status in driver_status.items():
                            await ws.send_json({
                                "type": "driver_status_update",
                                "driver_id": driver_id,
                                "status": status
                            })
                    
                    elif msg_type == "register_driver":
                        driver_id_to_register = data.get("driver_id")
                        logger.info(f"Proses registrasi untuk Driver ID: '{driver_id_to_register}' dari klien dengan ID saat ini '{current_ws_identifier}' (ws: {id(ws)})")

                        if driver_id_to_register and driver_id_to_register in DRIVER_IDS_AVAILABLE:
                            # 1. Clean up any existing connection for this driver ID
                            existing_ws_for_id = WEBRTC_DRIVERS.get(driver_id_to_register)
                            if existing_ws_for_id:
                                if existing_ws_for_id != ws:
                                    if not existing_ws_for_id.closed:
                                        logger.warning(f"Driver ID '{driver_id_to_register}' sudah digunakan oleh koneksi aktif lain (ws: {id(existing_ws_for_id)}). Menghentikan koneksi lama.")
                                        try:
                                            await existing_ws_for_id.close()
                                        except:
                                            pass
                                    logger.info(f"Membersihkan entri lama untuk Driver ID '{driver_id_to_register}' (ws lama: {id(existing_ws_for_id)})")
                                    await cleanup_client_webrtc(existing_ws_for_id)
                            
                            # 2. If this ws was previously a supervisor, remove from supervisor set
                            if ws in WEBRTC_SUPERVISORS:
                                WEBRTC_SUPERVISORS.discard(ws)
                                logger.info(f"Klien '{current_ws_identifier}' (sebelumnya supervisor) kini menjadi driver '{driver_id_to_register}'.")

                            # 3. Clean up old identifier mapping for this ws
                            if current_ws_identifier != driver_id_to_register and current_ws_identifier in WEBRTC_CLIENTS_BY_ID:
                                if WEBRTC_CLIENTS_BY_ID.get(current_ws_identifier) == ws:
                                     logger.info(f"Menghapus identifier lama '{current_ws_identifier}' dari CLIENTS_BY_ID karena akan diganti '{driver_id_to_register}' untuk ws {id(ws)}.")
                                     del WEBRTC_CLIENTS_BY_ID[current_ws_identifier]
                            
                            # 4. Register the driver with current ws connection
                            WEBRTC_DRIVERS[driver_id_to_register] = ws      
                            WEBRTC_CLIENTS_BY_WS[ws] = driver_id_to_register 
                            WEBRTC_CLIENTS_BY_ID[driver_id_to_register] = ws 
                            
                            logger.info(f"✓ Driver WebRTC '{driver_id_to_register}' terdaftar dengan ws {id(ws)}. Total Driver Aktif: {len(WEBRTC_DRIVERS)}")
                            logger.info(f"   WEBRTC_CLIENTS_BY_ID['{driver_id_to_register}'] sekarang menunjuk ke ws {id(WEBRTC_CLIENTS_BY_ID.get(driver_id_to_register))}")
                            logger.info(f"   WEBRTC_DRIVERS['{driver_id_to_register}'] sekarang menunjuk ke ws {id(WEBRTC_DRIVERS.get(driver_id_to_register))}")
                            
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
                            
                            # Debug: Show current state of mappings
                            logger.info(f"Debug - WEBRTC_CLIENTS_BY_ID keys: {list(WEBRTC_CLIENTS_BY_ID.keys())}")
                            logger.info(f"Debug - WEBRTC_DRIVERS keys: {list(WEBRTC_DRIVERS.keys())}")
                            logger.info(f"Debug - Target '{target_id}' in CLIENTS_BY_ID: {target_id in WEBRTC_CLIENTS_BY_ID}")
                            logger.info(f"Debug - Target '{target_id}' in DRIVERS: {target_id in WEBRTC_DRIVERS}")

                            target_ws = WEBRTC_CLIENTS_BY_ID.get(target_id)
                            if target_ws and not target_ws.closed:
                                try:
                                    await target_ws.send_json({
                                        "type": "webrtc_signal",
                                        "sender_id": sender_id,
                                        "payload": payload
                                    })
                                    logger.info(f"✓ Sinyal WebRTC berhasil dikirim dari '{sender_id}' ke '{target_id}'")
                                except Exception as e:
                                    logger.error(f"Gagal mengirim sinyal WebRTC dari '{sender_id}' ke '{target_id}': {e}")
                                    await ws.send_json({"type": "error", "message": f"Gagal mengirim sinyal ke '{target_id}': {str(e)}"})
                            else:
                                logger.warning(f"Target WebRTC signal '{target_id}' tidak ditemukan atau sudah terputus.")
                                logger.warning(f"   target_ws: {target_ws}, closed: {target_ws.closed if target_ws else 'N/A'}")
                                
                                # Clean up if the target exists but is closed
                                if target_ws and target_ws.closed:
                                    logger.info(f"Membersihkan target yang terputus: {target_id}")
                                    await cleanup_client_webrtc(target_ws)
                                
                                await ws.send_json({"type": "error", "message": f"Target ID '{target_id}' tidak tersedia atau tidak online."})

                    elif msg_type == "call_request":
                        target_driver_id = data.get("target_driver_id")
                        supervisor_requesting_id = WEBRTC_CLIENTS_BY_WS.get(ws) 
                        
                        logger.info(f"Call request dari Supervisor '{supervisor_requesting_id}' ke Driver '{target_driver_id}'")
                        
                        # Check both WEBRTC_DRIVERS and WEBRTC_CLIENTS_BY_ID for consistency
                        driver_ws_target = WEBRTC_DRIVERS.get(target_driver_id)
                        driver_ws_target_alt = WEBRTC_CLIENTS_BY_ID.get(target_driver_id)
                        
                        logger.info(f"Debug - Driver lookup: DRIVERS={driver_ws_target is not None}, CLIENTS_BY_ID={driver_ws_target_alt is not None}")
                        
                        if driver_ws_target and not driver_ws_target.closed:
                            logger.info(f"✓ Driver '{target_driver_id}' ditemukan dan online. Mengirim incoming_call...")
                            try:
                                await driver_ws_target.send_json({"type": "incoming_call", "from_supervisor_id": supervisor_requesting_id})
                                logger.info(f"✓ Incoming call berhasil dikirim ke Driver '{target_driver_id}'")
                            except Exception as e:
                                logger.error(f"Gagal mengirim incoming_call ke '{target_driver_id}': {e}")
                                await ws.send_json({"type": "call_failed", "reason": f"Gagal mengirim panggilan ke Driver '{target_driver_id}': {str(e)}"})
                        else:
                            logger.warning(f"✗ Driver '{target_driver_id}' tidak online atau tidak ditemukan saat call_request.")
                            await ws.send_json({"type": "call_failed", "reason": f"Driver '{target_driver_id}' tidak online atau tidak ditemukan."})
                            
                            # Clean up if driver exists but is closed
                            if driver_ws_target and driver_ws_target.closed: 
                                logger.info(f"Membersihkan driver yang terputus: {target_driver_id}")
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
                                        "sender_id": supervisor_cancelling_id,
                                        "payload": { "type": "call_cancelled_by_supervisor", "reason": "Supervisor membatalkan panggilan."}
                                    })
                                    logger.info(f"✓ Pembatalan panggilan berhasil dikirim ke Driver '{target_driver_id}'")
                                except Exception as e_send_cancel: 
                                    logger.warning(f"Gagal kirim pembatalan ke {target_driver_id}: {e_send_cancel}")
                            else:
                                logger.warning(f"Target driver '{target_driver_id}' tidak ditemukan atau sudah terputus saat cancel_call_attempt")
                        else: 
                            logger.warning(f"Pesan cancel_call_attempt tidak valid: {data}")

                    elif msg_type == "driver_drowsy_notification": 
                        driver_id = data.get("driver_id")
                        original_message = data.get("original_opencv_message", "Kantuk terdeteksi!")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if driver_id and sender_id == driver_id: 
                            logger.info(f"Notifikasi kantuk dari Driver '{driver_id}'. Meneruskan ke supervisor...")
                            await broadcast_to_supervisors({"type": "supervisor_drowsiness_alert", "driver_id": driver_id, "message": original_message})
                        else: 
                            logger.warning(f"driver_drowsy_notification tidak valid: {data} dari {sender_id}")
                    
                    elif msg_type == "driver_normal_notification": 
                        driver_id = data.get("driver_id")
                        sender_id = WEBRTC_CLIENTS_BY_WS.get(ws)
                        if driver_id and sender_id == driver_id:
                            logger.info(f"Notifikasi normal dari Driver '{driver_id}'. Meneruskan ke supervisor...")
                            await broadcast_to_supervisors({"type": "supervisor_driver_normal", "driver_id": driver_id, "message": f"Driver {driver_id} kembali normal."})
                        else: 
                            logger.warning(f"driver_normal_notification tidak valid: {data} dari {sender_id}")
                    
                    elif msg_type == "ping":
                        await ws.send_json({"type": "pong", "timestamp": time.time()})
                    
                    else:
                        logger.warning(f"Tipe pesan tidak dikenal: '{msg_type}' dari {current_ws_identifier}")

                except json.JSONDecodeError: 
                    logger.error(f"Pesan WS tidak valid JSON: {msg.data}")
                except Exception as e_inner: 
                    logger.error(f"Error proses pesan WS dari '{WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}': {e_inner}", exc_info=True)
            
            elif msg.type == web.WSMsgType.ERROR: 
                logger.error(f'Koneksi WS error untuk {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}: {ws.exception()}')
                break 
            
            elif msg.type == web.WSMsgType.CLOSED:
                logger.info(f"Pesan CLOSED diterima dari klien {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)}")
                break 
    
    except asyncio.CancelledError:
        logger.info(f"Task WebSocket untuk {WEBRTC_CLIENTS_BY_WS.get(ws, temp_client_id)} dibatalkan.")
    except Exception as main_handler_exception:
        logger.error(f"Kesalahan dalam WebSocket handler: {main_handler_exception}")
    finally:
        await cleanup_client_webrtc(ws)
        if not ws.closed:
            await ws.close()
        logger.info(f"Koneksi WebSocket ditutup untuk ws: {id(ws)}")
    
    return ws

async def serve_html_js_asset(request):
    server_backend_dir = os.path.dirname(os.path.abspath(__file__))
    project_root_dir = os.path.abspath(os.path.join(server_backend_dir, '..'))
    filepath = None; path = request.path
    
    if path == "/" or path == "/supervisor": filepath = os.path.join(project_root_dir, 'Client_Supervisor', 'Supervisor.html')
    elif path == "/driver": filepath = os.path.join(project_root_dir, 'Client_Driver', 'templates', 'Driver.html')
    elif path == "/assets/supervisor.js": filepath = os.path.join(project_root_dir, 'Client_Supervisor', 'Supervisor.js')
    elif path == "/assets/driver.js": filepath = os.path.join(project_root_dir, 'Client_Driver', 'Driver.js')
    
    if filepath and os.path.exists(filepath): 
        return web.FileResponse(filepath)
    elif path == "/favicon.ico": 
        return web.Response(status=204) 
    else: 
        logger.warning(f"Resource tidak ditemukan: {request.path}")
        return web.Response(status=404, text=f"Resource {request.path} not found")

async def on_shutdown(app_on_shutdown):
    logger.info("Memulai proses shutdown server...")
    active_clients = list(WEBRTC_CLIENTS_BY_WS.keys()) 
    for ws_conn in active_clients: 
        if not ws_conn.closed: 
            try: 
                await ws_conn.close(code=web.WSCloseCode.GOING_AWAY, message=b'Server shutdown') 
            except Exception: 
                pass
    logger.info("Semua upaya penutupan koneksi WebRTC aktif selesai.")

async def periodic_cleanup():
    """Periodic task to clean up disconnected clients"""
    while True:
        try:
            await asyncio.sleep(30)  # Run every 30 seconds
            await validate_and_cleanup_drivers()
            
            # Also clean up supervisors
            supervisors_to_remove = []
            for supervisor_ws in WEBRTC_SUPERVISORS:
                if supervisor_ws.closed:
                    supervisors_to_remove.append(supervisor_ws)
            
            for supervisor_ws in supervisors_to_remove:
                await cleanup_client_webrtc(supervisor_ws)
                
        except Exception as e:
            logger.error(f"Error dalam periodic cleanup: {e}")

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

    # Start periodic cleanup task
    cleanup_task = asyncio.create_task(periodic_cleanup())

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
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
        logger.info("Membersihkan runner aiohttp...")
        await runner.cleanup() 
        logger.info("Runner aiohttp telah dibersihkan.")

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Aplikasi dihentikan (Ctrl+C di __main__).")
    finally:
        logging.info("Aplikasi selesai.")