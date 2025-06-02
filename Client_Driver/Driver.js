// File: Client_Driver/Driver.js

const OPENCV_SERVER_HOST = 'localhost'; 
const OPENCV_SERVER_PORT = '5000';

const WEBRTC_SERVER_HOST = location.hostname; 
const WEBRTC_SERVER_PORT = '8080'; 
const WEBRTC_WS_URL = `ws://${WEBRTC_SERVER_HOST}:${WEBRTC_SERVER_PORT}/ws-webrtc`;

const OPENCV_SOCKETIO_URL = `http://${OPENCV_SERVER_HOST}:${OPENCV_SERVER_PORT}`;
const OPENCV_VIDEO_FEED_BASE_URL = `http://${OPENCV_SERVER_HOST}:${OPENCV_SERVER_PORT}/video_feed`;

let webrtcWebsocket;
let peerConnectionDriver;
let localStreamDriver;
let myDriverId = null;
let currentCallerId = null;
let opencvSocket;

const localVideoDriver = document.getElementById('localVideoDriver');
const remoteVideoDriver = document.getElementById('remoteVideoDriver');
const callStatusDriverUI = document.getElementById('callStatusDriver');
const incomingCallAlertUI = document.getElementById('incomingCallAlert');
const acceptCallBtn = document.getElementById('acceptCallBtn');
const rejectCallBtn = document.getElementById('rejectCallBtn');
const callerIdTextUI = document.getElementById('callerIdText');
const driverIdInput = document.getElementById('driverIdInput');
const registerDriverBtn = document.getElementById('registerDriverBtn');
const registrationStatusUI = document.getElementById('registrationStatus');
const registrationPanel = document.getElementById('registrationPanel');
const callPanel = document.getElementById('callPanel');
const systemStatusOpenCVEl = document.getElementById('systemStatusOpenCV');
const calibrationStatusOpenCVEl = document.getElementById('calibrationStatusOpenCV');
const earValueOpenCVEl = document.getElementById('earValueOpenCV');
const perclosValueOpenCVEl = document.getElementById('perclosValueOpenCV');
const thresholdValueOpenCVEl = document.getElementById('thresholdValueOpenCV');
const alertMessageOpenCVEl = document.getElementById('alertMessageOpenCV');
const opencvVideoFeedEl = document.getElementById('opencvVideoFeed');

const iceServersDriver = { iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ]};

if (registerDriverBtn) {
    registerDriverBtn.onclick = () => {
        console.log("Tombol 'Daftar ke Sistem WebRTC' diklik!");
        if(!driverIdInput || !registrationStatusUI) {
            console.error("Elemen input ID atau status registrasi tidak ditemukan!"); return;
        }
        myDriverId = driverIdInput.value.trim();
        if (myDriverId) {
            if (registrationStatusUI) registrationStatusUI.textContent = `Mencoba mendaftar WebRTC sebagai ${myDriverId}...`;
            connectWebRTCWebSocket();
        } else {
            if (registrationStatusUI) registrationStatusUI.textContent = 'ID Driver WebRTC tidak boleh kosong.';
        }
    };
} else { console.error("Tombol 'registerDriverBtn' tidak ditemukan!"); }

function connectWebRTCWebSocket() {
    if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN && webrtcWebsocket.url === WEBRTC_WS_URL) {
        console.log("WebRTC WS sudah terbuka dan URL cocok, mengirim register_driver ulang.");
        webrtcWebsocket.send(JSON.stringify({ type: 'register_driver', driver_id: myDriverId }));
        return;
    }
    if (webrtcWebsocket) { 
        console.log("Menutup koneksi WebRTC WS lama...");
        webrtcWebsocket.onopen = null; 
        webrtcWebsocket.onmessage = null;
        webrtcWebsocket.onerror = null;
        webrtcWebsocket.onclose = null;
        webrtcWebsocket.close();
    }
    console.log(`Mencoba koneksi WebRTC WS ke: ${WEBRTC_WS_URL}`);
    webrtcWebsocket = new WebSocket(WEBRTC_WS_URL);

    webrtcWebsocket.onopen = () => {
        console.log(`Terhubung ke Server WebRTC (${WEBRTC_WS_URL}) sebagai ${myDriverId}`);
        webrtcWebsocket.send(JSON.stringify({ type: 'register_driver', driver_id: myDriverId }));
    };

    webrtcWebsocket.onerror = (error) => {
        console.error('WebSocket Error (WebRTC Driver):', error);
        if (registrationStatusUI) registrationStatusUI.textContent = 'Gagal terhubung ke server WebRTC.';
    };

    webrtcWebsocket.onclose = (event) => {
        console.log('Koneksi WebSocket WebRTC Driver terputus. Kode:', event.code, 'Alasan:', event.reason);
        const alreadyRegistered = registrationStatusUI && registrationStatusUI.textContent.includes("Terdaftar di WebRTC");
        
        if (registrationPanel && callPanel && 
            (!alreadyRegistered || (callPanel.style.display === 'none' && registrationPanel.style.display !== 'block'))) {
            registrationPanel.style.display = 'block';
            callPanel.style.display = 'none';
            if (registrationStatusUI && !alreadyRegistered) {
                 registrationStatusUI.textContent = "Koneksi WebRTC terputus. Silakan daftar ulang.";
            }
        } else if (callStatusDriverUI && alreadyRegistered && callPanel.style.display !== 'none') {
             callStatusDriverUI.textContent = 'WebRTC: Terputus dari server.';
        }
        if (peerConnectionDriver) {
            resetCallStateDriver();
        }
    };
    
    webrtcWebsocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Driver Menerima (WebRTC):', data);
        switch (data.type) {
            case 'registration_successful':
                if (registrationStatusUI) registrationStatusUI.textContent = `Terdaftar di WebRTC sebagai ${data.driver_id}.`;
                if (registrationPanel) registrationPanel.style.display = 'none';
                if (callPanel) callPanel.style.display = 'block';
                if (callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menunggu panggilan...';
                break;
            case 'incoming_call': handleIncomingCall(data.from_supervisor_id); break;
            case 'webrtc_signal': handleWebRTCSignalDriver(data); break;
            case 'error':
                if (registrationStatusUI) registrationStatusUI.textContent = `Error WebRTC: ${data.message}`;
                if (data.message && data.message.toLowerCase().includes("id driver sudah digunakan")) {
                    if (registrationPanel) registrationPanel.style.display = 'block';
                    if (callPanel) callPanel.style.display = 'none';
                }
                break;
            case 'webrtc_signal_failed':
                alert(`Gagal memproses panggilan: ${data.reason}.`);
                if (data.original_payload_type === "offer" || data.original_payload_type === "answer") resetCallStateDriver();
                break;
            case 'call_failed':
                alert(`Panggilan gagal dari server: ${data.reason}`);
                resetCallStateDriver();
                break;
            default: console.warn("Driver menerima pesan WebRTC tipe tidak dikenal:", data);
        }
    };
}

function handleIncomingCall(fromSupervisorId) {
    console.log(`Panggilan WebRTC masuk dari Supervisor: ${fromSupervisorId}`);
    if (peerConnectionDriver && peerConnectionDriver.signalingState !== "closed") {
        if (webrtcWebsocket && fromSupervisorId) {
            webrtcWebsocket.send(JSON.stringify({ type: 'webrtc_signal', target_id: fromSupervisorId, payload: { type: 'call_busy', reason: 'driver_busy' }}));
        }
        return;
    }
    currentCallerId = fromSupervisorId;
    if(callerIdTextUI) callerIdTextUI.textContent = fromSupervisorId ? fromSupervisorId.substring(0,8) : 'Supervisor';
    if(incomingCallAlertUI) incomingCallAlertUI.style.display = 'block';
    if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Panggilan masuk...';
    if(acceptCallBtn) acceptCallBtn.onclick = () => acceptCall(fromSupervisorId);
    if(rejectCallBtn) rejectCallBtn.onclick = () => rejectCall(fromSupervisorId);
}

async function acceptCall(callerId) {
    console.log(`Menerima panggilan WebRTC dari ${callerId}`);
    if(incomingCallAlertUI) incomingCallAlertUI.style.display = 'none';
    if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menerima panggilan...';
    currentCallerId = callerId;
    try {
        localStreamDriver = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if(localVideoDriver) localVideoDriver.srcObject = localStreamDriver;
    } catch (error) {
        console.error('Error mendapatkan media lokal (Driver WebRTC):', error);
        if(callStatusDriverUI) callStatusDriverUI.textContent = 'Error WebRTC: Gagal akses kamera/mikrofon.';
        if (webrtcWebsocket && currentCallerId) {
             webrtcWebsocket.send(JSON.stringify({ type: 'webrtc_signal', target_id: currentCallerId, payload: { type: 'call_rejected', reason: 'media_error_on_driver' }}));
        }
        resetCallStateDriver(); return;
    }
    peerConnectionDriver = new RTCPeerConnection(iceServersDriver);
    if (localStreamDriver) { localStreamDriver.getTracks().forEach(track => peerConnectionDriver.addTrack(track, localStreamDriver)); }
    peerConnectionDriver.onicecandidate = event => {
        if (event.candidate && webrtcWebsocket && currentCallerId) {
            webrtcWebsocket.send(JSON.stringify({ type: 'webrtc_signal', target_id: currentCallerId, payload: { type: 'candidate', candidate: event.candidate }}));
        }
    };
    peerConnectionDriver.ontrack = event => { if(remoteVideoDriver) remoteVideoDriver.srcObject = event.streams[0]; };
    peerConnectionDriver.onconnectionstatechange = event => {
        if(!peerConnectionDriver) return;
        console.log("Status koneksi Peer (Driver WebRTC):", peerConnectionDriver.connectionState);
        if(callStatusDriverUI) callStatusDriverUI.textContent = `Status WebRTC: ${peerConnectionDriver.connectionState}`;
        if (['disconnected', 'failed', 'closed'].includes(peerConnectionDriver.connectionState)) { resetCallStateDriver(); }
    };
    if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menunggu offer dari supervisor...'; 
}

function rejectCall(callerId) {
    if(incomingCallAlertUI) incomingCallAlertUI.style.display = 'none';
    if (webrtcWebsocket && callerId) {
        webrtcWebsocket.send(JSON.stringify({ type: 'webrtc_signal', target_id: callerId, payload: { type: 'call_rejected', reason: 'driver_rejected_call' }}));
    }
    if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Panggilan ditolak.';
    currentCallerId = null; setTimeout(() => { if(callStatusDriverUI && callStatusDriverUI.textContent === 'WebRTC: Panggilan ditolak.') callStatusDriverUI.textContent = 'WebRTC: Menunggu panggilan...';}, 3000);
}

async function handleWebRTCSignalDriver(data) {
    if (!data.from_id) { console.error("Sinyal WebRTC tanpa from_id:", data); return; }
    const payload = data.payload; const fromId = data.from_id;
    console.log(`Driver: Menerima sinyal WebRTC tipe '${payload.type}' dari ${fromId}`);
    if (payload.type === 'offer') {
        if (!peerConnectionDriver && currentCallerId === fromId ) { 
             console.warn("Offer diterima, PC belum ada, memanggil acceptCall (seharusnya sudah dipanggil).");
             await acceptCall(fromId); 
             if (!peerConnectionDriver) { 
                 console.error("Gagal memproses offer karena acceptCall tidak berhasil membuat PeerConnection.");
                 return; 
             }
        } else if (currentCallerId && fromId !== currentCallerId) { 
            console.log(`Offer dari ${fromId}, tapi panggilan aktif dengan ${currentCallerId}. Abaikan.`); return; 
        } else if (!peerConnectionDriver) {
            console.error("Menerima offer tapi tidak dalam proses panggilan atau PC belum siap."); return;
        }
        
        try {
            await peerConnectionDriver.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: payload.sdp }));
            const answer = await peerConnectionDriver.createAnswer();
            await peerConnectionDriver.setLocalDescription(answer);
            if (webrtcWebsocket && fromId) {
                webrtcWebsocket.send(JSON.stringify({ type: 'webrtc_signal', target_id: fromId, payload: { type: 'answer', sdp: answer.sdp }}));
            }
            if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Panggilan terhubung!';
        } catch (error) { console.error('Error setRemoteDescription (offer) atau createAnswer:', error); }

    } else if (payload.type === 'candidate') {
        if (peerConnectionDriver && peerConnectionDriver.remoteDescription) {
            try { await peerConnectionDriver.addIceCandidate(new RTCIceCandidate(payload.candidate)); }
            catch (error) { console.error('Error menambah ICE candidate (Driver):', error); }
        } else { 
            console.warn("Menerima ICE candidate sebelum remoteDescription atau PC siap:", payload.candidate); 
            // TODO: Implementasi antrian ICE candidate jika diperlukan
        }
    } else if (payload.type === 'call_rejected' || payload.type === 'call_ended_by_supervisor' || payload.type === 'call_busy' || payload.type === 'call_cancelled_by_supervisor') { // Tangani pembatalan dari supervisor
        resetCallStateDriver(); 
        if(callStatusDriverUI) callStatusDriverUI.textContent = `WebRTC Panggilan diakhiri/dibatalkan: ${payload.reason || 'Info dari supervisor'}`;
        if(incomingCallAlertUI) incomingCallAlertUI.style.display = 'none';
    }
}

function resetCallStateDriver() {
    if (localStreamDriver) { localStreamDriver.getTracks().forEach(track => track.stop()); localStreamDriver = null; }
    if (peerConnectionDriver) { 
        peerConnectionDriver.onicecandidate = null; peerConnectionDriver.ontrack = null; 
        peerConnectionDriver.onconnectionstatechange = null; peerConnectionDriver.close(); 
        peerConnectionDriver = null; 
    }
    if(localVideoDriver) localVideoDriver.srcObject = null; 
    if(remoteVideoDriver) remoteVideoDriver.srcObject = null;
    if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menunggu panggilan...';
    if(incomingCallAlertUI) incomingCallAlertUI.style.display = 'none'; 
    currentCallerId = null;
}

// --- BAGIAN DATA OPENCV (Socket.IO) ---
function connectOpenCVDataStream() {
    console.log(`Mencoba terhubung ke server OpenCV di ${OPENCV_SOCKETIO_URL}`);
    if (typeof io === "undefined") {
        console.error("Pustaka Socket.IO (io) tidak ditemukan!");
        if(systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Error: Pustaka io()'; systemStatusOpenCVEl.className = 'status-error';}
        return;
    }
    opencvSocket = io.connect(OPENCV_SOCKETIO_URL, { reconnectionAttempts: 5, reconnectionDelay: 3000 });
    opencvSocket.on('connect', () => {
        if(systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Terhubung OpenCV. Menunggu kamera...'; systemStatusOpenCVEl.className = 'status-calibrating';}
    });
    opencvSocket.on('disconnect', (reason) => {
        if(systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Koneksi OpenCV Terputus'; systemStatusOpenCVEl.className = 'status-error';}
        if(alertMessageOpenCVEl) setOpenCVAlertMessage('Koneksi server deteksi terputus!', 'error');
    });
    opencvSocket.on('connect_error', (err) => {
        if(systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Gagal Hub. Deteksi OpenCV'; systemStatusOpenCVEl.className = 'status-error';}
        if(alertMessageOpenCVEl) setOpenCVAlertMessage(`Gagal hub. server deteksi di ${OPENCV_SOCKETIO_URL}. Error: ${err.message}`, 'error');
    });
    opencvSocket.on('status_update', (data) => {
        if (!systemStatusOpenCVEl || !calibrationStatusOpenCVEl || !alertMessageOpenCVEl || !thresholdValueOpenCVEl || !earValueOpenCVEl || !perclosValueOpenCVEl) return;
        if (data.message) {
            if (data.type === 'error') { systemStatusOpenCVEl.textContent = data.message; systemStatusOpenCVEl.className = 'status-error'; setOpenCVAlertMessage(data.message, 'error'); }
            else if (data.type === 'calibration_info') { systemStatusOpenCVEl.textContent = data.message; systemStatusOpenCVEl.className = 'status-calibrating'; calibrationStatusOpenCVEl.textContent = 'Sedang Berlangsung'; }
            else if (data.type === 'calibration_done') { systemStatusOpenCVEl.textContent = 'OpenCV Terkalibrasi & Memantau'; systemStatusOpenCVEl.className = 'status-monitoring'; calibrationStatusOpenCVEl.textContent = 'Selesai'; setOpenCVAlertMessage(data.message || 'Kalibrasi Selesai!', 'normal'); }
            else if (data.type === 'no_face') { systemStatusOpenCVEl.textContent = data.message; systemStatusOpenCVEl.className = 'status-no-face'; earValueOpenCVEl.textContent = '-'; perclosValueOpenCVEl.textContent = '-';}
            else { systemStatusOpenCVEl.textContent = data.message; }
        }
        if (data.is_calibrated !== undefined) calibrationStatusOpenCVEl.textContent = data.is_calibrated ? 'Selesai' : (systemStatusOpenCVEl.className === 'status-calibrating' ? 'Sedang Berlangsung' : 'Belum');
        if (data.dynamic_threshold !== undefined) thresholdValueOpenCVEl.textContent = formatOpenCVValue(data.dynamic_threshold, 3);
    });
    opencvSocket.on('update_data', (data) => {
        if (!earValueOpenCVEl || !perclosValueOpenCVEl || !calibrationStatusOpenCVEl || !thresholdValueOpenCVEl || !alertMessageOpenCVEl || !systemStatusOpenCVEl) return;
        earValueOpenCVEl.textContent = formatOpenCVValue(data.ear, 3);
        perclosValueOpenCVEl.textContent = formatOpenCVValue(data.perclos !== -1 ? (Number(data.perclos) * 100) : -1, 1, '-') + (data.perclos !== -1 && data.perclos != null ? '%' : '');
        if (data.is_calibrated !== undefined) calibrationStatusOpenCVEl.textContent = data.is_calibrated ? 'Selesai' : (systemStatusOpenCVEl.className === 'status-calibrating' ? 'Sedang Berlangsung' : 'Belum');
        if (data.dynamic_threshold !== undefined) thresholdValueOpenCVEl.textContent = formatOpenCVValue(data.dynamic_threshold, 3);
        const currentAlertClasses = alertMessageOpenCVEl.className;
        if (!currentAlertClasses.includes('alert-critical') && !currentAlertClasses.includes('alert-warning') && systemStatusOpenCVEl.className !== 'status-no-face') {
            if (data.is_calibrated) { if (!systemStatusOpenCVEl.textContent.includes("Memantau")) { systemStatusOpenCVEl.textContent = 'OpenCV Memantau...'; systemStatusOpenCVEl.className = 'status-monitoring'; }}
            else { if (!systemStatusOpenCVEl.textContent.includes("Kalibrasi")) { systemStatusOpenCVEl.textContent = 'Kalibrasi OpenCV...'; systemStatusOpenCVEl.className = 'status-calibrating';}}
        }
    });
    opencvSocket.on('drowsiness_alert', (data) => {
        if (!alertMessageOpenCVEl || !systemStatusOpenCVEl || !calibrationStatusOpenCVEl) return;
        console.log('Drowsiness Alert (OpenCV Diterima):', data);
        setOpenCVAlertMessage(data.message, data.type);
        if (data.type === 'alert') {
            systemStatusOpenCVEl.textContent = 'KANTUK OPENCV TERDETEKSI!'; systemStatusOpenCVEl.className = 'status-error';
            if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN && myDriverId) {
                console.log(`Mengirim notifikasi kantuk untuk ${myDriverId} ke server WebRTC.`);
                webrtcWebsocket.send(JSON.stringify({ type: 'driver_drowsy_notification', driver_id: myDriverId, original_opencv_message: data.message }));
            } else { console.warn("Tidak bisa kirim notifikasi kantuk ke server WebRTC: WS_WebRTC tidak terhubung atau Driver ID belum terdaftar."); }
        } else if (data.type === 'normal') {
            let isCalibrated = data.is_calibrated !== undefined ? data.is_calibrated : (calibrationStatusOpenCVEl.textContent === 'Selesai');
            if (isCalibrated) { systemStatusOpenCVEl.textContent = 'OpenCV Memantau...'; systemStatusOpenCVEl.className = 'status-monitoring';}
            else { systemStatusOpenCVEl.textContent = 'Kalibrasi OpenCV...'; systemStatusOpenCVEl.className = 'status-calibrating';}
            if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN && myDriverId) {
                webrtcWebsocket.send(JSON.stringify({ type: 'driver_normal_notification', driver_id: myDriverId }));
            }
        }
    });
}
function formatOpenCVValue(value, precision = 3, defaultValue = '-') { return (value != null && value !== -1 && !isNaN(Number(value))) ? Number(value).toFixed(precision) : defaultValue; }
function setOpenCVAlertMessage(message, type) {
    if (!alertMessageOpenCVEl) return;
    alertMessageOpenCVEl.textContent = message; alertMessageOpenCVEl.className = 'alert-message-opencv';
    if (type === 'alert') alertMessageOpenCVEl.classList.add('alert-critical');
    else if (type === 'warning') alertMessageOpenCVEl.classList.add('alert-warning');
    else if (type === 'normal' || type === 'info' || type === 'calibration_done') alertMessageOpenCVEl.classList.add('alert-normal');
    else if (type === 'error') alertMessageOpenCVEl.classList.add('alert-critical');
    else alertMessageOpenCVEl.classList.add('alert-normal');
}

// INISIALISASI
document.addEventListener('DOMContentLoaded', (event) => {
    connectOpenCVDataStream();
    const opencvFeedImg = document.getElementById('opencvVideoFeed');
    if (opencvFeedImg) {
        const opencvFeedUrl = `${OPENCV_VIDEO_FEED_BASE_URL}?_cachebust=${new Date().getTime()}`;
        opencvFeedImg.src = opencvFeedUrl;
        opencvFeedImg.onerror = () => {
            console.error(`Gagal memuat OpenCV video feed dari ${opencvFeedUrl}.`);
            if (systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Gagal load video OpenCV.'; systemStatusOpenCVEl.className = 'status-error';}
            if (opencvVideoFeedEl) { opencvVideoFeedEl.alt = `Error: Gagal load video dari ${opencvFeedUrl}. Server OpenCV tidak aktif/terjangkau.`;}
        };
    } else { console.error("Elemen gambar 'opencvVideoFeed' tidak ditemukan!"); }
});