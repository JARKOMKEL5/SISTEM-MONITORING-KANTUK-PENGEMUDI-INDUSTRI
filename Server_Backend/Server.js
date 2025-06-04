const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*", // Allow all origins for simplicity, restrict in production
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000; // Port for Node.js server

// Store connected users.
// For simplicity, we'll assume one driver instance for this example.
// A more robust system would handle multiple drivers and rooms.
let driverSocket = null; // Stores the socket of the Python/Driver client
let supervisors = {}; // Stores supervisor sockets: { socketId: socket, ... }
let driverWebClientSocket = null; // Stores the socket of the Driver's WebRTC client (browser)

io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    // Role registration
    socket.on('register_driver_vision', (data) => {
        driverSocket = socket; // Python script connects here
        console.log(`Driver Vision Process registered: ${socket.id} with driverId: ${data.driverId}`);
        socket.driverId = data.driverId; // Store driverId on the socket object
        // Notify supervisors if any
        for (const sid in supervisors) {
            supervisors[sid].emit('driver_status_update', { driverId: data.driverId, status: 'online_vision' });
        }
    });

    socket.on('register_driver_web', (data) => {
        driverWebClientSocket = socket; // Driver's browser for WebRTC
        socket.driverId = data.driverId;
        console.log(`Driver Web Client registered: ${socket.id} for driverId: ${data.driverId}`);
        // Link this web client to the vision process if possible, or assume they share a driverId
        for (const sid in supervisors) {
            supervisors[sid].emit('driver_status_update', { driverId: data.driverId, status: 'online_web' });
        }
    });

    socket.on('register_supervisor', () => {
        supervisors[socket.id] = socket;
        console.log(`Supervisor registered: ${socket.id}`);
        // Send current driver status to the new supervisor
        if (driverSocket && driverSocket.driverId) {
            socket.emit('driver_status_update', {
                driverId: driverSocket.driverId,
                status: driverWebClientSocket ? 'online_web' : 'online_vision'
            });
        }
    });

    // Drowsiness alert from Python script, relayed to supervisors
    socket.on('drowsiness_alert_from_python', (alertData) => {
        console.log(`Drowsiness alert received for driver ${alertData.driverId}:`, alertData.message);
        for (const sid in supervisors) {
            supervisors[sid].emit('drowsiness_alert_to_supervisor', alertData);
        }
    });

    // WebRTC Signaling
    socket.on('initiate_call_to_driver', (data) => { // From Supervisor
        console.log(`Supervisor ${socket.id} initiating call to driver ${data.targetDriverId}`);
        if (driverWebClientSocket && driverWebClientSocket.driverId === data.targetDriverId) {
            console.log(`Sending incoming_call_from_supervisor to driver web client ${driverWebClientSocket.id}`);
            driverWebClientSocket.emit('incoming_call_from_supervisor', {
                fromSupervisorSid: socket.id
            });
        } else {
            console.log(`Driver web client for ${data.targetDriverId} not found or ID mismatch.`);
            socket.emit('call_error', { message: `Driver ${data.targetDriverId} not available for call.` });
        }
    });

    socket.on('webrtc_offer', (data) => { // Can be from Supervisor to Driver
        const { sdp, targetSid, callerSid } = data;
        console.log(`Relaying WebRTC Offer from ${callerSid} to ${targetSid}`);
        io.to(targetSid).emit('webrtc_offer', { sdp, callerSid });
    });

    socket.on('webrtc_answer', (data) => { // From Driver to Supervisor
        const { sdp, targetSid, calleeSid } = data;
        console.log(`Relaying WebRTC Answer from ${calleeSid} to ${targetSid}`);
        io.to(targetSid).emit('webrtc_answer', { sdp, calleeSid });
    });

    socket.on('webrtc_ice_candidate', (data) => {
        const { candidate, targetSid, senderSid } = data;
        console.log(`Relaying ICE Candidate from ${senderSid} to ${targetSid}`);
        io.to(targetSid).emit('webrtc_ice_candidate', { candidate, senderSid });
    });

    socket.on('call_ended_by_client', (data) => {
        const { targetSid, enderSid } = data;
        console.log(`Call ended by ${enderSid}, notifying ${targetSid}`);
        io.to(targetSid).emit('call_ended_notification', { enderSid });
    });


    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        if (socket === driverSocket) {
            console.log(`Driver Vision Process ${socket.driverId} disconnected.`);
            const driverId = socket.driverId;
            driverSocket = null;
            for (const sid in supervisors) {
                supervisors[sid].emit('driver_status_update', { driverId: driverId, status: 'offline' });
            }
        } else if (socket === driverWebClientSocket) {
            console.log(`Driver Web Client ${socket.driverId} disconnected.`);
            const driverId = socket.driverId;
            driverWebClientSocket = null;
            // Optionally update supervisor status if vision process is also offline
            if (!driverSocket || driverSocket.driverId !== driverId) {
                 for (const sid in supervisors) {
                    supervisors[sid].emit('driver_status_update', { driverId: driverId, status: 'offline' });
                }
            } else {
                 for (const sid in supervisors) { // Still online via vision
                    supervisors[sid].emit('driver_status_update', { driverId: driverId, status: 'online_vision' });
                }
            }
        } else if (supervisors[socket.id]) {
            delete supervisors[socket.id];
            console.log(`Supervisor ${socket.id} disconnected.`);
        }
    });
});

http.listen(PORT, () => {
    console.log(`Node.js Signaling Server listening on *:${PORT}`);
});