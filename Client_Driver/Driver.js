const localVideoDriver = document.getElementById('localVideoDriver');
const remoteVideoDriver = document.getElementById('remoteVideoDriver');
const callStatusElement = document.getElementById('call-status');
const answerCallBtn = document.getElementById('answerCallBtn');
const endCallBtnDriver = document.getElementById('endCallBtnDriver');
const socketStatusElement = document.getElementById('socketStatus');

const driverId = document.getElementById('driverIdDisplay').textContent; // Get DRIVER_ID from HTML
const NODE_SERVER_URL = 'location.hostname'; // Ensure this matches your Node.js server

const socket = io(NODE_SERVER_URL);

let localStreamDriver;
let rtcPeerConnectionDriver;
let supervisorSidForCall = null; // SID of the supervisor who is calling

const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

socket.on('connect', () => {
    console.log('Terhubung ke Node.js Server sebagai Driver Web Client.');
    socketStatusElement.textContent = `Terhubung (${socket.id})`;
    socket.emit('register_driver_web', { driverId: driverId });
});

socket.on('disconnect', () => {
    console.log('Terputus dari Node.js Server.');
    socketStatusElement.textContent = 'Terputus';
    resetCallState();
});

socket.on('connect_error', (err) => {
    console.error('Koneksi Socket.IO gagal:', err);
    socketStatusElement.textContent = `Error Koneksi: ${err.message}`;
});


// Driver receives call initiation from supervisor
socket.on('incoming_call_from_supervisor', async (data) => {
    supervisorSidForCall = data.fromSupervisorSid;
    console.log(`Panggilan masuk dari Supervisor SID: ${supervisorSidForCall}`);
    callStatusElement.textContent = `Panggilan masuk dari Supervisor (${supervisorSidForCall}). Menunggu penawaran...`;
    // UI to answer call could be shown here. For now, we'll auto-prepare.
    // Or, more realistically, wait for the offer then show answer button.
    answerCallBtn.style.display = 'block';
    answerCallBtn.onclick = () => {
        // This button might not be needed if offer comes right after.
        // Typically, answering is tied to receiving the offer.
        // For now, it's a placeholder. The offer handler will show it if not already.
        console.log("Tombol Jawab diklik (mungkin tidak melakukan apa-apa jika offer belum diterima)");
    };

});

// Driver receives offer from supervisor
socket.on('webrtc_offer', async (data) => {
    const { sdp, callerSid } = data; // callerSid is supervisorSidForCall
    supervisorSidForCall = callerSid; // Ensure it's set

    console.log(`Menerima WebRTC offer dari Supervisor SID: ${callerSid}`);
    callStatusElement.textContent = `Menerima tawaran panggilan dari Supervisor. Klik 'Jawab'.`;
    answerCallBtn.style.display = 'block';
    endCallBtnDriver.style.display = 'none';


    answerCallBtn.onclick = async () => {
        answerCallBtn.disabled = true;
        try {
            if (!localStreamDriver) {
                localStreamDriver = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                localVideoDriver.srcObject = localStreamDriver;
            }

            rtcPeerConnectionDriver = new RTCPeerConnection(iceServers);
            rtcPeerConnectionDriver.onicecandidate = onIceCandidateDriver;
            rtcPeerConnectionDriver.ontrack = onTrackDriver;

            localStreamDriver.getTracks().forEach(track => {
                rtcPeerConnectionDriver.addTrack(track, localStreamDriver);
            });

            await rtcPeerConnectionDriver.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await rtcPeerConnectionDriver.createAnswer();
            await rtcPeerConnectionDriver.setLocalDescription(answer);

            console.log('Mengirim WebRTC answer ke Supervisor SID:', supervisorSidForCall);
            socket.emit('webrtc_answer', {
                sdp: rtcPeerConnectionDriver.localDescription,
                targetSid: supervisorSidForCall,
                calleeSid: socket.id // Driver's web socket ID
            });
            callStatusElement.textContent = 'Panggilan terhubung dengan Supervisor.';
            answerCallBtn.style.display = 'none';
            answerCallBtn.disabled = false;
            endCallBtnDriver.style.display = 'block';
        } catch (error) {
            console.error('Gagal menjawab panggilan:', error);
            callStatusElement.textContent = `Error menjawab: ${error.message}`;
            answerCallBtn.disabled = false;
            resetCallState();
        }
    };
});


socket.on('webrtc_ice_candidate', (data) => {
    const { candidate, senderSid } = data;
    console.log(`Menerima ICE candidate dari SID: ${senderSid}`);
    if (rtcPeerConnectionDriver && candidate) {
        rtcPeerConnectionDriver.addIceCandidate(new RTCIceCandidate(candidate))
            .catch(e => console.error("Error adding received ICE candidate", e));
    }
});

socket.on('call_ended_notification', (data) => {
    console.log(`Panggilan diakhiri oleh pihak lain (SID: ${data.enderSid})`);
    callStatusElement.textContent = 'Panggilan diakhiri oleh Supervisor.';
    resetCallState();
});

function onIceCandidateDriver(event) {
    if (event.candidate && supervisorSidForCall) {
        console.log('Mengirim ICE candidate ke Supervisor SID:', supervisorSidForCall);
        socket.emit('webrtc_ice_candidate', {
            candidate: event.candidate,
            targetSid: supervisorSidForCall,
            senderSid: socket.id
        });
    }
}

function onTrackDriver(event) {
    console.log('Menerima remote track dari Supervisor.');
    remoteVideoDriver.srcObject = event.streams[0];
}

endCallBtnDriver.addEventListener('click', () => {
    if (supervisorSidForCall) {
        socket.emit('call_ended_by_client', { targetSid: supervisorSidForCall, enderSid: socket.id });
    }
    resetCallState();
    callStatusElement.textContent = 'Panggilan diakhiri oleh Anda.';
});

function resetCallState() {
    if (localStreamDriver) {
        localStreamDriver.getTracks().forEach(track => track.stop());
        localStreamDriver = null;
    }
    if (rtcPeerConnectionDriver) {
        rtcPeerConnectionDriver.close();
        rtcPeerConnectionDriver = null;
    }
    localVideoDriver.srcObject = null;
    remoteVideoDriver.srcObject = null;
    supervisorSidForCall = null;
    answerCallBtn.style.display = 'none';
    endCallBtnDriver.style.display = 'none';
    // callStatusElement.textContent = 'Belum ada panggilan.'; // Keep last status or reset
}

// Optional: Listen for drowsiness alerts if Node.js server relays them back (for UI consistency)
// socket.on('drowsiness_alert_to_driver_web', (alertData) => {
//     console.log("Menerima update status kantuk untuk UI:", alertData);
//     // Update some UI element if needed, though Python frame shows most of it.
// });