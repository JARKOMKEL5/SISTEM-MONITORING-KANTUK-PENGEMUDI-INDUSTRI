// File: Server_Backend/Server.js
// (Versi terbaru dengan perbaikan path, ReferenceError, dan PREDEFINED_AVAILABLE_DRIVER_IDS)
const express = require('express');
const http =require('http');
const WebSocket = require('ws');
const path = require('path');
const uuid = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

// Daftar ID Driver yang dikenali oleh sistem
const PREDEFINED_AVAILABLE_DRIVER_IDS = ['Driver1', 'DriverAlpha', 'DriverBeta', 'DriverTest', 'Driver2', 'Driver3'];

const supervisors = new Map(); // ws -> supervisorId (objek ws sebagai key)
const drivers = new Map(); // driverId -> ws (string driverId sebagai key)
const clientDetails = new Map(); // ws -> { id, type } (objek ws sebagai key)

console.log("==========================================================");
console.log("      Node.js WebRTC Signaling Server for Drowsiness Monitor");
console.log("==========================================================");

// --- Serve HTML & JS Assets ---
// __dirname di sini akan menjadi '.../MONITORING-KANTUK/Server_Backend'
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../Client_Supervisor', 'Supervisor.html')));
app.get('/supervisor', (req, res) => res.sendFile(path.join(__dirname, '../Client_Supervisor', 'Supervisor.html')));
app.get('/assets/supervisor.js', (req, res) => res.sendFile(path.join(__dirname, '../Client_Supervisor', 'Supervisor.js')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, '../Client_Driver', 'templates', 'Driver.html')));
app.get('/assets/driver.js', (req, res) => res.sendFile(path.join(__dirname, '../Client_Driver', 'Driver.js')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// --- WebSocket Server Logic ---
wss.on('connection', (ws) => {
    const tempClientId = `temp-${uuid.v4().substring(0,8)}`; // ID sementara yang lebih singkat
    clientDetails.set(ws, { id: tempClientId, type: 'unknown' });
    console.log(`[Server] Client connected with temp ID: ${tempClientId}`);

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('[Server] Failed to parse message or message is not JSON:', message.toString());
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message format.' }));
            return;
        }

        const currentClientInfo = clientDetails.get(ws);
        if (!currentClientInfo) {
            console.error(`[Server] Could not find client info for an active WebSocket. This shouldn't happen.`);
            return;
        }
        const senderIdForLog = currentClientInfo.id || 'unknown'; // Gunakan ID yang sudah teregister jika ada

        console.log(`[Server] Received from '${senderIdForLog}' (type: ${currentClientInfo.type}):`, data.type, data.driver_id || data.supervisor_id || data.target_id || '');


        switch (data.type) {
            case 'register_supervisor':
                const supervisorId = data.supervisor_id || `supervisor_${uuid.v4().substring(0,5)}`;
                // Hapus dari drivers jika ws ini sebelumnya driver
                for (const [id, driverWs] of drivers.entries()) {
                    if (driverWs === ws) {
                        drivers.delete(id);
                        console.log(`[Server] Client '${supervisorId}' (was driver '${id}') removed from drivers.`);
                        // Tidak perlu broadcastDriverList di sini karena dia jadi supervisor
                        break;
                    }
                }
                supervisors.set(ws, supervisorId); // ws adalah key
                clientDetails.set(ws, { id: supervisorId, type: 'supervisor' });
                console.log(`[Server] Supervisor registered: ${supervisorId}`);
                ws.send(JSON.stringify({ type: 'registration_successful', supervisor_id: supervisorId }));
                sendDriverListToSupervisor(ws);
                break;

            case 'register_driver':
                const driverId = data.driver_id;
                if (!driverId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Driver ID is required.' }));
                    return;
                }
                if (!PREDEFINED_AVAILABLE_DRIVER_IDS.includes(driverId)) {
                    ws.send(JSON.stringify({ type: 'error', message: `Driver ID '${driverId}' is not recognized.` }));
                    return;
                }

                if (supervisors.has(ws)) { // supervisors key adalah ws
                    const oldSupId = supervisors.get(ws);
                    supervisors.delete(ws);
                     console.log(`[Server] Client '${driverId}' (was supervisor '${oldSupId}') removed from supervisors.`);
                }
                if (drivers.has(driverId) && drivers.get(driverId) !== ws) {
                    const oldWs = drivers.get(driverId);
                    console.warn(`[Server] Driver ID '${driverId}' collision. Closing old connection.`);
                    oldWs.send(JSON.stringify({ type: 'error', message: 'ID registered by new session. Closing this one.'}));
                    oldWs.terminate(); // Lebih tegas dari close()
                }

                drivers.set(driverId, ws); // driverId (string) adalah key
                clientDetails.set(ws, { id: driverId, type: 'driver' });
                console.log(`[Server] Driver registered: ${driverId}`);
                ws.send(JSON.stringify({ type: 'registration_successful', driver_id: driverId }));
                broadcastDriverListToSupervisors();
                break;

            case 'webrtc_signal':
                const targetId = data.target_id;
                const payload = data.payload;
                const senderId = currentClientInfo.id;

                if (!targetId || !payload || !senderId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'target_id, payload, and sender_id are required for webrtc_signal.' }));
                    return;
                }

                let targetWs = null;
                if (drivers.has(targetId)) { // Target adalah driver
                    targetWs = drivers.get(targetId);
                } else { // Target mungkin supervisor
                    for(const [sWs, sIdVal] of supervisors.entries()){ // supervisors Map: key=ws, value=supervisorId
                        if(sIdVal === targetId) {
                            targetWs = sWs;
                            break;
                        }
                    }
                }
                // Fallback jika ID tidak spesifik (jarang terjadi jika client terdaftar dengan benar)
                if (!targetWs) {
                    for (const [socket, details] of clientDetails.entries()) {
                        if (details.id === targetId) {
                            targetWs = socket;
                            break;
                        }
                    }
                }

                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    console.log(`[Server] Relaying WebRTC signal from '${senderId}' to '${targetId}' (Payload Type: ${payload.type})`);
                    targetWs.send(JSON.stringify({
                        type: 'webrtc_signal',
                        sender_id: senderId,
                        payload: payload
                    }));
                } else {
                    console.warn(`[Server] Target '${targetId}' for WebRTC signal from '${senderId}' not found or connection not open.`);
                    ws.send(JSON.stringify({
                        type: 'webrtc_signal_failed',
                        original_payload_type: payload.type,
                        target_id: targetId,
                        reason: `Target '${targetId}' not available or connection closed.`
                    }));
                    if (PREDEFINED_AVAILABLE_DRIVER_IDS.includes(targetId) && !drivers.has(targetId)){
                         broadcastDriverListToSupervisors(); // Update status driver jadi offline
                    }
                }
                break;

            case 'driver_drowsy_notification':
                if (currentClientInfo.type === 'driver') {
                    console.log(`[Server] Drowsiness alert from Driver '${currentClientInfo.id}': ${data.original_opencv_message}`);
                    broadcastToSupervisors({
                        type: 'supervisor_drowsiness_alert',
                        driver_id: currentClientInfo.id,
                        message: data.original_opencv_message || 'Drowsiness Detected!',
                        timestamp: data.timestamp
                    });
                }
                break;

            case 'driver_normal_notification':
                 if (currentClientInfo.type === 'driver') {
                    console.log(`[Server] Normal status from Driver '${currentClientInfo.id}'`);
                    broadcastToSupervisors({
                        type: 'supervisor_driver_normal',
                        driver_id: currentClientInfo.id,
                        message: `Driver ${currentClientInfo.id} is now normal.`,
                        timestamp: data.timestamp
                    });
                }
                break;

            case 'request_driver_list': // Supervisor meminta daftar driver
                 if (currentClientInfo.type === 'supervisor') {
                    console.log(`[Server] Supervisor '${currentClientInfo.id}' requested driver list.`);
                    sendDriverListToSupervisor(ws);
                }
                break;
            
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong', server_time: Date.now() }));
                break;

            default:
                console.warn(`[Server] Unknown message type from '${senderIdForLog}': ${data.type}`);
                ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${data.type}` }));
        }
    });

    ws.on('close', () => {
        const clientInfo = clientDetails.get(ws);
        if (!clientInfo || clientInfo.id === tempClientId) { // Jangan proses jika belum terdaftar penuh
            console.log(`[Server] Temp client '${tempClientId}' disconnected before full registration.`);
            clientDetails.delete(ws);
            return;
        }

        console.log(`[Server] Client disconnected: ${clientInfo.id} (Type: ${clientInfo.type})`);
        
        if (clientInfo.type === 'supervisor') {
            supervisors.delete(ws); // Key adalah ws
            console.log(`[Server] Supervisor '${clientInfo.id}' removed. Total supervisors: ${supervisors.size}`);
        } else if (clientInfo.type === 'driver') {
            // Pastikan menghapus ws yang benar jika ada duplikasi ID sementara (seharusnya sudah ditangani)
            if(drivers.get(clientInfo.id) === ws) {
                drivers.delete(clientInfo.id); // Key adalah driverId (string)
                console.log(`[Server] Driver '${clientInfo.id}' removed. Total online drivers: ${drivers.size}`);
            }
            broadcastDriverListToSupervisors(); // Update semua supervisor tentang status driver
        }
        clientDetails.delete(ws);
    });

    ws.on('error', (error) => {
        const clientInfo = clientDetails.get(ws);
        const clientIdForLog = clientInfo ? clientInfo.id : tempClientId;
        console.error(`[Server] WebSocket error for client '${clientIdForLog}':`, error);
        // Event 'close' biasanya akan mengikuti, menangani cleanup.
    });
});

function broadcastToSupervisors(message) {
    if (supervisors.size === 0) return;
    // console.log('[Server] Broadcasting to supervisors:', message);
    supervisors.forEach((supervisorId, supervisorWs) => { // Map: key=ws, value=supervisorId
        if (supervisorWs.readyState === WebSocket.OPEN) {
            supervisorWs.send(JSON.stringify(message));
        }
    });
}

function sendDriverListToSupervisor(supervisorWs) {
    const supervisorClientInfo = clientDetails.get(supervisorWs);
    const targetSupervisorId = supervisorClientInfo ? supervisorClientInfo.id : 'N/A';
    console.log(`[Server] Sending full driver status list to supervisor '${targetSupervisorId}'`);

    PREDEFINED_AVAILABLE_DRIVER_IDS.forEach(driverId => {
        const status = drivers.has(driverId) ? 'online' : 'offline';
        supervisorWs.send(JSON.stringify({
            type: 'driver_status_update',
            driver_id: driverId,
            status: status
        }));
    });
    // Mengirim juga daftar ID driver yang online saja (untuk kompatibilitas atau kebutuhan spesifik klien)
    const onlineDriverIds = Array.from(drivers.keys());
    supervisorWs.send(JSON.stringify({
        type: 'driver_list', 
        drivers: onlineDriverIds
    }));
}

function broadcastDriverListToSupervisors() {
    if (supervisors.size === 0) return;
    console.log('[Server] Broadcasting full driver status list to all supervisors.');
    supervisors.forEach((supervisorId, supervisorWs) => { // Map: key=ws, value=supervisorId
        if (supervisorWs.readyState === WebSocket.OPEN) {
            sendDriverListToSupervisor(supervisorWs);
        }
    });
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] HTTP and WebSocket server running on 0.0.0.0:${PORT}`);
    console.log(`         Supervisor Dashboard: http://<YOUR_SERVER_IP>:${PORT}/supervisor`);
    console.log(`         Driver Dashboard: http://<YOUR_SERVER_IP>:${PORT}/driver`);
});