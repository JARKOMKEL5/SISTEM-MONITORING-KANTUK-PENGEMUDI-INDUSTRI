const localVideoSupervisor = document.getElementById('localVideoSupervisor');
const remoteVideoSupervisor = document.getElementById('remoteVideoSupervisor');
const callDriverBtn = document.getElementById('callDriverBtn');
const endCallBtnSupervisor = document.getElementById('endCallBtnSupervisor');
const targetDriverIdInput = document.getElementById('targetDriverIdInput');
const supervisorCallStatus = document.getElementById('supervisorCallStatus');
const alertsLog = document.getElementById('alerts-log');
const driverConnectionStatus = document.getElementById('driverConnectionStatus');
const supervisorSocketStatus = document.getElementById('supervisorSocketStatus');
const targetDriverIdInputDisplay = document.getElementById('targetDriverIdInputDisplay');


const NODE_SERVER_URL = location.hostname; // Ensure this matches
const socket = io(NODE_SERVER_URL);

let localStreamSupervisor;
let rtcPeerConnectionSupervisor;
let driverSidForCall = null; // This will be the driver's web socket ID after they answer or during offer/answer

const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

socket.on('connect', () => {
    console.log('Terhubung ke Node.js Server sebagai Supervisor.');
    supervisorSocketStatus.textContent = `Terhubung (${socket.id})`;
    socket.emit('register_supervisor');
    targetDriverIdInputDisplay.textContent = targetDriverIdInput.value; // Update display
});

socket.on('disconnect', () => {
    console.log('Terputus dari Node.js Server.');
    supervisorSocketStatus.textContent = 'Terputus';
    resetCallStateSupervisor();
});

socket.on('connect_error', (err) => {
    console.error('Koneksi Socket.IO Supervisor gagal:', err);
    supervisorSocketStatus.textContent = `Error Koneksi: ${err.message}`;
});


// Listen for driver status updates
socket.on('driver_status_update', (data) => {
    console.log("Driver status update:", data);
    if (data.driverId === targetDriverIdInput.value) {
        driverConnectionStatus.textContent = data.status.replace('_', ' ').toUpperCase();
        callDriverBtn.disabled = !(data.status === 'online_web' || data.status === 'online_vision'); // Enable call if web client is up
    }
});

// Listen for drowsiness alerts
socket.on('drowsiness_alert_to_supervisor', (alertData) => {
    console.log('Peringatan kantuk diterima:', alertData);
    const logItem = document.createElement('li');
    const timestamp = new Date().toLocaleTimeString();
    logItem.textContent = `[${timestamp}] Driver ${alertData.driverId}: ${alertData.message} (EAR: ${alertData.ear}, PERCLOS: ${alertData.perclos || 'N/A'})`;
    logItem.className = alertData.type === 'alert' ? 'alert-critical' : 'alert-normal';
    
    // Remove placeholder if it exists
    if (alertsLog.firstChild && alertsLog.firstChild.textContent === "Belum ada peringatan.") {
        alertsLog.removeChild(alertsLog.firstChild);
    }
    alertsLog.prepend(logItem); // Add new alert to the top
});

callDriverBtn.addEventListener('click', async () => {
    const targetDriverId = targetDriverIdInput.value;
    if (!targetDriverId) {
        alert('Masukkan ID Driver target!');
        return;
    }
    targetDriverIdInputDisplay.textContent = targetDriverId; // Update display

    callDriverBtn.disabled = true;
    supervisorCallStatus.textContent = `Menghubungi Driver ${targetDriverId}...`;

    try {
        localStreamSupervisor = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideoSupervisor.srcObject = localStreamSupervisor;

        // Emit an event to Node.js to check if driver is ready and get their web SID
        // The Node.js server will then emit 'incoming_call_from_supervisor' to the driver's web client
        socket.emit('initiate_call_to_driver', { targetDriverId: targetDriverId });
        // The actual offer creation will happen after driver's browser acknowledges or Node confirms
        // For now, we assume 'initiate_call_to_driver' leads to an 'offer' phase if successful.
        // The offer is created *after* the peer connection is set up upon driver's readiness (handled by webrtc_answer)
        // Let's re-think: Supervisor *sends* the offer after initiating.

        rtcPeerConnectionSupervisor = new RTCPeerConnection(iceServers);
        rtcPeerConnectionSupervisor.onicecandidate = onIceCandidateSupervisor;
        rtcPeerConnectionSupervisor.ontrack = onTrackSupervisor;

        localStreamSupervisor.getTracks().forEach(track => {
            rtcPeerConnectionSupervisor.addTrack(track, localStreamSupervisor);
        });
        
        // Create offer
        const offer = await rtcPeerConnectionSupervisor.createOffer();
        await rtcPeerConnectionSupervisor.setLocalDescription(offer);

        console.log(`Mengirim WebRTC offer ke driver (melalui server untuk dirutekan ke ${targetDriverId})`);
        // The server needs to know which specific driver's web client (socket.id) to send this to.
        // The Node.js 'initiate_call_to_driver' should probably resolve this mapping.
        // For now, we assume the 'webrtc_offer' event on the server can find the target driver's web SID.
        // A better flow: 'initiate_call' -> Node confirms target -> Supervisor sends offer to specific driver's web SID.
        // Simplified: Send offer, server will route based on its knowledge of targetDriverId's web socket.
        // The Node server's 'webrtc_offer' event is currently routed based on `targetSid`.
        // We need to make sure the `targetSid` here is the *driver's web client SID*.
        // This is a bit tricky if we only have driverId. The Node server needs to map driverId to driverWebClientSocket.id.
        // The `initiate_call_to_driver` helps here. If successful, server knows who `driverWebClientSocket` is.
        // The supervisor doesn't know driver's web SID initially.
        // So, Node server needs to forward the offer.
        // Let's make the `webrtc_offer` event from supervisor include `targetDriverId`
        // Node will then find `driverWebClientSocket.id` for that `targetDriverId` and forward.

        // Modifying the 'webrtc_offer' payload for supervisor:
        socket.emit('webrtc_offer', {
            sdp: rtcPeerConnectionSupervisor.localDescription,
            targetDriverId: targetDriverId, // Node server will use this to find the driver's web client SID
            callerSid: socket.id
        });
        supervisorCallStatus.textContent = `Tawaran dikirim ke Driver ${targetDriverId}. Menunggu jawaban...`;
        endCallBtnSupervisor.style.display = 'block';


    } catch (error) {
        console.error('Gagal memulai panggilan:', error);
        supervisorCallStatus.textContent = `Error: ${error.message}`;
        callDriverBtn.disabled = false;
        resetCallStateSupervisor();
    }
});


// Supervisor receives answer from driver
socket.on('webrtc_answer', async (data) => {
    const { sdp, calleeSid } = data; // calleeSid is driver's web socket ID
    driverSidForCall = calleeSid; // Store it
    console.log(`Menerima WebRTC answer dari Driver SID: ${calleeSid}`);
    supervisorCallStatus.textContent = 'Jawaban diterima. Panggilan terhubung.';
    try {
        if (rtcPeerConnectionSupervisor && rtcPeerConnectionSupervisor.signalingState !== "closed") {
            await rtcPeerConnectionSupervisor.setRemoteDescription(new RTCSessionDescription(sdp));
        } else {
            console.warn("Peer connection tidak ada atau sudah ditutup saat menerima answer.");
        }
    } catch (error) {
        console.error("Error setting remote description from answer:", error);
    }
});

socket.on('webrtc_ice_candidate', (data) => {
    const { candidate, senderSid } = data;
    console.log(`Menerima ICE candidate dari SID: ${senderSid}`);
    if (rtcPeerConnectionSupervisor && candidate) {
        rtcPeerConnectionSupervisor.addIceCandidate(new RTCIceCandidate(candidate))
            .catch(e => console.error("Error adding received ICE candidate (supervisor)", e));
    }
});

socket.on('call_error', (data) => {
    supervisorCallStatus.textContent = `Gagal Panggil: ${data.message}`;
    callDriverBtn.disabled = false;
    resetCallStateSupervisor();
});


socket.on('call_ended_notification', (data) => {
    console.log(`Panggilan diakhiri oleh pihak lain (SID: ${data.enderSid})`);
    supervisorCallStatus.textContent = 'Panggilan diakhiri oleh Driver.';
    resetCallStateSupervisor();
});


function onIceCandidateSupervisor(event) {
    // driverSidForCall should be set once the answer comes back, or if offer was targeted to a known SID.
    // Since the offer is sent to targetDriverId, Node server routes it.
    // When driver answers, it includes its SID (`calleeSid`).
    // When candidate is sent, the target should be that `calleeSid`.
    if (event.candidate && driverSidForCall) {
        console.log('Mengirim ICE candidate ke Driver SID:', driverSidForCall);
        socket.emit('webrtc_ice_candidate', {
            candidate: event.candidate,
            targetSid: driverSidForCall, // Target the driver's web socket ID
            senderSid: socket.id
        });
    }
}

function onTrackSupervisor(event) {
    console.log('Menerima remote track dari Driver.');
    remoteVideoSupervisor.srcObject = event.streams[0];
}

endCallBtnSupervisor.addEventListener('click', () => {
    if (driverSidForCall) { // driverSidForCall is the SID of the driver's web client
        socket.emit('call_ended_by_client', { targetSid: driverSidForCall, enderSid: socket.id });
    }
    resetCallStateSupervisor();
    supervisorCallStatus.textContent = 'Panggilan diakhiri oleh Anda.';
});

function resetCallStateSupervisor() {
    if (localStreamSupervisor) {
        localStreamSupervisor.getTracks().forEach(track => track.stop());
        localStreamSupervisor = null;
    }
    if (rtcPeerConnectionSupervisor) {
        rtcPeerConnectionSupervisor.close();
        rtcPeerConnectionSupervisor = null;
    }
    localVideoSupervisor.srcObject = null;
    remoteVideoSupervisor.srcObject = null;
    driverSidForCall = null;
    callDriverBtn.disabled = false;
    endCallBtnSupervisor.style.display = 'none';
    // supervisorCallStatus.textContent = 'Tidak ada panggilan aktif.'; // Keep last status or reset
}

// Update the targetDriverId display when input changes
targetDriverIdInput.addEventListener('change', () => {
    targetDriverIdInputDisplay.textContent = targetDriverIdInput.value;
    // Optionally, re-fetch driver status or clear it
    driverConnectionStatus.textContent = "Unknown (ID changed)";
});