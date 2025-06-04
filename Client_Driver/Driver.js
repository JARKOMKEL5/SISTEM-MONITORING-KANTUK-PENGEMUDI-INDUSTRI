// File: Client_Driver/Driver.js
// (Versi lengkap dengan auto-accept call dan manajemen kamera terkoordinasi)

// =====================================================================================
// KONFIGURASI SERVER (PENTING: Sesuaikan jika perlu!)
// =====================================================================================
const OPENCV_SERVER_HOST = 'localhost'; 
const OPENCV_SERVER_PORT = '5000';
const WEBRTC_SERVER_HOST = location.hostname;
const WEBRTC_SERVER_PORT = '8080';
const WEBRTC_WS_URL = `ws://${WEBRTC_SERVER_HOST}:${WEBRTC_SERVER_PORT}`;
const OPENCV_VIDEO_FEED_BASE_URL = `http://${OPENCV_SERVER_HOST}:${OPENCV_SERVER_PORT}/video_feed`;
// =====================================================================================

let webrtcWebsocket;
let peerConnectionDriver;
let localStreamDriver;
let myDriverId = null;
let currentCallerId = null;
let opencvSocket;
let iceCandidateQueue = [];
let isWebRTCCallActive = false;
let opencvFeedOriginalSrc = '';
let opencvFeedActualURL = ''; // Deklarasi global

// --- Elemen DOM ---
const localVideoDriver = document.getElementById('localVideoDriver');
const remoteVideoDriver = document.getElementById('remoteVideoDriver');
const callStatusDriverUI = document.getElementById('callStatusDriver');
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

let heartbeatInterval;
const CAMERA_RELEASE_DELAY_MS = 700; // Waktu tunggu (ms) agar Python sempat melepaskan kamera

const iceServersDriver = {
    iceServers: [ { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' } ]
};

if (registerDriverBtn) {
    registerDriverBtn.onclick = () => {
        console.log("[DriverJS] Tombol 'Daftar ke Sistem WebRTC' diklik.");
        if (!driverIdInput || !registrationStatusUI) { console.error("[DriverJS] Elemen DOM registrasi tidak ditemukan!"); return; }
        myDriverId = driverIdInput.value.trim();
        if (myDriverId) {
            registrationStatusUI.textContent = `Mencoba mendaftar WebRTC sebagai ${myDriverId}...`;
            connectWebRTCWebSocket();
        } else { registrationStatusUI.textContent = 'ID Driver WebRTC tidak boleh kosong.'; }
    };
} else { console.warn("[DriverJS] Tombol 'registerDriverBtn' tidak ditemukan."); }

function connectWebRTCWebSocket() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (webrtcWebsocket && (webrtcWebsocket.readyState === WebSocket.OPEN || webrtcWebsocket.readyState === WebSocket.CONNECTING)) {
        webrtcWebsocket.onopen = null; webrtcWebsocket.onmessage = null; webrtcWebsocket.onerror = null; webrtcWebsocket.onclose = null;
        webrtcWebsocket.close();
    }
    console.log(`[DriverJS] Mencoba koneksi WebRTC WS ke Node.js server: ${WEBRTC_WS_URL}`);
    webrtcWebsocket = new WebSocket(WEBRTC_WS_URL);
    webrtcWebsocket.onopen = () => {
        console.log(`[DriverJS] Terhubung ke Server WebRTC Node.js (${WEBRTC_WS_URL})`);
        if (myDriverId) {
            webrtcWebsocket.send(JSON.stringify({ type: 'register_driver', driver_id: myDriverId }));
            heartbeatInterval = setInterval(() => {
                if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN) {
                    webrtcWebsocket.send(JSON.stringify({ type: 'ping' }));
                }
            }, 25000);
        } else {
            console.error("[DriverJS] Driver ID kosong saat register_driver.");
            if (registrationStatusUI) registrationStatusUI.textContent = 'Registrasi gagal: ID Driver kosong.';
        }
    };
    webrtcWebsocket.onerror = (error) => {
        console.error('[DriverJS] WebSocket Error (WebRTC to Node.js):', error);
        if (registrationStatusUI) registrationStatusUI.textContent = 'Gagal terhubung ke server WebRTC Node.js.';
        if (heartbeatInterval) clearInterval(heartbeatInterval);
    };
    webrtcWebsocket.onclose = (event) => {
        console.log('[DriverJS] Koneksi WebRTC WS (Node.js) terputus. Kode:', event.code, 'Alasan:', event.reason);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        const isRegistered = registrationStatusUI && registrationStatusUI.textContent.includes("Terdaftar di WebRTC");
        if (registrationPanel && callPanel && (!isRegistered || (callPanel.style.display === 'none' && registrationPanel.style.display !== 'block'))) {
            registrationPanel.style.display = 'block';
            callPanel.style.display = 'none';
            if (registrationStatusUI && !isRegistered) registrationStatusUI.textContent = "Koneksi WebRTC terputus. Silakan daftar ulang.";
        } else if (callStatusDriverUI && isRegistered && callPanel.style.display !== 'none') {
             callStatusDriverUI.textContent = 'WebRTC: Terputus dari server.';
        }
        if (peerConnectionDriver || isWebRTCCallActive) resetCallStateDriver();
    };
    webrtcWebsocket.onmessage = (event) => { handleWebRTCSignalDriver(JSON.parse(event.data)); };
}

function pauseOpenCVDetection() {
    console.log('[DriverJS] Menjeda UI dan data stream deteksi OpenCV untuk panggilan WebRTC...');
    if (opencvSocket && opencvSocket.connected) {
        opencvSocket.disconnect(); 
        console.log('[DriverJS] Koneksi Socket.IO OpenCV diputus selama panggilan.');
    }
    if (opencvVideoFeedEl) {
        if (!opencvFeedOriginalSrc && opencvVideoFeedEl.src && opencvVideoFeedEl.src !== window.location.href) {
             opencvFeedOriginalSrc = opencvVideoFeedEl.src;
        }
        opencvVideoFeedEl.src = ''; 
        opencvVideoFeedEl.style.display = 'none';
        console.log('[DriverJS] Video feed OpenCV dihentikan dan disembunyikan.');
    }
    if (systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Deteksi kantuk dijeda (panggilan WebRTC).'; systemStatusOpenCVEl.className = 'status-no-face'; }
    if (alertMessageOpenCVEl) { alertMessageOpenCVEl.textContent = 'Tidak Ada Peringatan'; alertMessageOpenCVEl.className = 'alert-normal'; }
    if(earValueOpenCVEl) earValueOpenCVEl.textContent = '-';
    if(perclosValueOpenCVEl) perclosValueOpenCVEl.textContent = '-';
    if(thresholdValueOpenCVEl) thresholdValueOpenCVEl.textContent = '-';
}

function resumeOpenCVDetection() {
    console.log('[DriverJS] Melanjutkan deteksi OpenCV setelah panggilan WebRTC...');
    if (opencvVideoFeedEl) {
        opencvFeedActualURL = OPENCV_VIDEO_FEED_BASE_URL + '?_cachebust=' + new Date().getTime();
        console.log(`[DriverJS DEBUG] resumeOpenCVDetection: OPENCV_SERVER_HOST=${OPENCV_SERVER_HOST}, OPENCV_SERVER_PORT=${OPENCV_SERVER_PORT}`);
        console.log(`[DriverJS DEBUG] resumeOpenCVDetection: OPENCV_VIDEO_FEED_BASE_URL=${OPENCV_VIDEO_FEED_BASE_URL}`);
        console.log(`[DriverJS] Mengatur src video feed OpenCV ke: ${opencvFeedActualURL} saat resume.`);
        opencvVideoFeedEl.src = opencvFeedActualURL;
        opencvVideoFeedEl.style.display = 'block';
    }
    connectOpenCVDataStream(); 
    if (systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Menghubungkan ke deteksi...'; systemStatusOpenCVEl.className = 'status-calibrating'; }
}

async function setupLocalMediaAndPC(callerId) {
    console.log(`[DriverJS] Menyiapkan media dan PeerConnection untuk ${callerId}`);
    currentCallerId = callerId;
    iceCandidateQueue = [];

    if (opencvSocket && opencvSocket.connected) {
        console.log('[DriverJS] Meminta server Python melepaskan kamera untuk WebRTC...');
        opencvSocket.emit('request_camera_release', { driver_id: myDriverId });
        await new Promise(resolve => setTimeout(resolve, CAMERA_RELEASE_DELAY_MS));
        console.log('[DriverJS] Selesai menunggu pelepasan kamera oleh Python.');
    } else { console.warn('[DriverJS] opencvSocket tidak terhubung, tidak dapat meminta pelepasan kamera ke Python.'); }
    
    try {
        const mediaConstraints = { video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 30 } }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
        localStreamDriver = await navigator.mediaDevices.getUserMedia(mediaConstraints);
        if (localVideoDriver) { localVideoDriver.srcObject = localStreamDriver; localVideoDriver.muted = true; }
        console.log('[DriverJS] Media lokal (kamera) berhasil didapatkan untuk WebRTC.');
    } catch (error) {
        console.error('[DriverJS] Gagal mendapatkan media lokal (kamera) untuk WebRTC:', error);
        if (callStatusDriverUI) callStatusDriverUI.textContent = `Error WebRTC: Gagal akses media (${error.name}).`;
        sendSignalToNodeJs(callerId, { type: 'call_rejected', reason: `media_error_on_driver: ${error.name}` });
        if (opencvSocket && opencvSocket.connected) {
            console.log('[DriverJS] Gagal media WebRTC, meminta Python mengambil kamera kembali...');
            opencvSocket.emit('request_camera_acquire', { driver_id: myDriverId });
        }
        isWebRTCCallActive = false; 
        return false;
    }

    isWebRTCCallActive = true;
    pauseOpenCVDetection(); 

    if (peerConnectionDriver) {
        peerConnectionDriver.onicecandidate = null; peerConnectionDriver.ontrack = null; peerConnectionDriver.onconnectionstatechange = null; peerConnectionDriver.oniceconnectionstatechange = null;
        if (peerConnectionDriver.signalingState !== "closed") peerConnectionDriver.close();
        peerConnectionDriver = null;
    }
    const rtcConfig = { ...iceServersDriver, iceCandidatePoolSize: 10 };
    peerConnectionDriver = new RTCPeerConnection(rtcConfig);
    if (localStreamDriver) { localStreamDriver.getTracks().forEach(track => peerConnectionDriver.addTrack(track, localStreamDriver)); }
    peerConnectionDriver.onicecandidate = event => { if (event.candidate && currentCallerId) sendSignalToNodeJs(currentCallerId, { type: 'candidate', candidate: event.candidate }); };
    peerConnectionDriver.ontrack = event => { if (remoteVideoDriver) remoteVideoDriver.srcObject = event.streams[0]; };
    peerConnectionDriver.onconnectionstatechange = () => {
        if (!peerConnectionDriver) return;
        const state = peerConnectionDriver.connectionState;
        console.log("[DriverJS] Status koneksi Peer:", state);
        if (callStatusDriverUI) callStatusDriverUI.textContent = `WebRTC: ${state}`;
        if (['disconnected', 'failed', 'closed'].includes(state)) {
            console.log('[DriverJS] Peer connection bermasalah, mereset state.');
            setTimeout(() => { if (currentCallerId || isWebRTCCallActive) resetCallStateDriver(); }, 500);
        }
    };
    peerConnectionDriver.oniceconnectionstatechange = () => {
        if (!peerConnectionDriver) return;
        if (peerConnectionDriver.iceConnectionState === 'failed') peerConnectionDriver.restartIce();
    };
    return true;
}

async function processOfferAndCreateAnswer(callerId, offerData) {
    console.log(`[DriverJS] Auto-accept panggilan dari ${callerId}, memproses offer.`);
    if (callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menerima panggilan otomatis...';
    const setupSuccess = await setupLocalMediaAndPC(callerId);
    if (!setupSuccess) { console.error("[DriverJS] Gagal setup media/PC. Panggilan tidak dapat dilanjutkan."); return; }
    try {
        await peerConnectionDriver.setRemoteDescription(new RTCSessionDescription(offerData.offer));
        iceCandidateQueue.forEach(candidate => peerConnectionDriver.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("[DriverJS] Error add ICE from queue:", e)));
        iceCandidateQueue = [];
        const answer = await peerConnectionDriver.createAnswer();
        await peerConnectionDriver.setLocalDescription(answer);
        sendSignalToNodeJs(callerId, { type: 'answer', answer: { sdp: answer.sdp, type: 'answer' } });
        if (callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menunggu koneksi...';
    } catch (error) {
        console.error('[DriverJS] Error memproses offer/answer:', error);
        if (callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Error proses panggilan';
        sendSignalToNodeJs(callerId, { type: 'call_rejected', reason: `offer_processing_error_on_driver: ${error.message || error}` });
        resetCallStateDriver();
    }
}

function sendSignalToNodeJs(targetId, payloadContent) {
    if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN) {
        webrtcWebsocket.send(JSON.stringify({ type: 'webrtc_signal', target_id: targetId, payload: payloadContent }));
    } else { console.error('[DriverJS] ❌ Tidak bisa mengirim sinyal: WebSocket (Node.js) tidak terhubung'); }
}

async function handleWebRTCSignalDriver(data) {
    switch (data.type) {
        case 'registration_successful': console.log(`[DriverJS] ✅ Driver ${data.driver_id} terdaftar.`); if (registrationStatusUI) registrationStatusUI.textContent = `Terdaftar di WebRTC sebagai ${data.driver_id}.`; if (registrationPanel) registrationPanel.style.display = 'none'; if (callPanel) callPanel.style.display = 'block'; if (callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menunggu panggilan...'; myDriverId = data.driver_id; return;
        case 'error': console.error('[DriverJS] Error dari server Node.js:', data.message); if (registrationStatusUI) registrationStatusUI.textContent = `Error WebRTC: ${data.message}`; if (data.message && (data.message.toLowerCase().includes("id driver sudah digunakan") || data.message.toLowerCase().includes("id is now registered by a new connection") || data.message.toLowerCase().includes("not recognized") )) { if (registrationPanel) registrationPanel.style.display = 'block'; if (callPanel) callPanel.style.display = 'none'; if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN) webrtcWebsocket.close(); } return;
        case 'pong': return;
        case 'webrtc_signal_failed': console.error(`[DriverJS] Sinyal WebRTC ke ${data.target_id} gagal: ${data.reason}`); return;
        case 'call_failed': console.error('[DriverJS] Panggilan gagal (server):', data.reason); alert(`Panggilan gagal: ${data.reason}`); return;
    }
    if (data.type !== 'webrtc_signal') { console.warn("[DriverJS] Pesan tidak terduga:", data); return; }
    const fromId = data.sender_id; const payload = data.payload;
    if (!fromId) { console.error("[DriverJS] Sinyal WebRTC tanpa sender_id:", data); return; }
    console.log(`[DriverJS] Menerima sinyal WebRTC '${payload.type}' dari ${fromId}`);
    switch (payload.type) {
        case 'offer': if (isWebRTCCallActive && currentCallerId && currentCallerId !== fromId) { console.warn(`[DriverJS] Panggilan aktif dengan ${currentCallerId}, menolak offer dari ${fromId}`); sendSignalToNodeJs(fromId, { type: 'call_busy', reason: 'driver_in_another_call' }); return; } console.log("[DriverJS] Menerima offer, proses otomatis..."); await processOfferAndCreateAnswer(fromId, payload); break;
        case 'candidate': if (peerConnectionDriver && peerConnectionDriver.remoteDescription && peerConnectionDriver.signalingState !== 'closed') { try { await peerConnectionDriver.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) { console.error('[DriverJS] Error add ICE candidate:', e); } } else { console.warn("[DriverJS] Menerima candidate tapi PC belum siap, antri."); iceCandidateQueue.push(payload.candidate); } break;
        case 'call_cancelled_by_supervisor': case 'call_ended': console.log(`[DriverJS] Panggilan dari ${fromId} ${payload.type}. Alasan: ${payload.reason || 'N/A'}`); if (fromId === currentCallerId || isWebRTCCallActive) { alert(`Panggilan dengan ${fromId ? fromId.substring(0,8) : 'supervisor'} ${payload.type === 'call_ended' ? 'diakhiri' : 'dibatalkan'}.`); resetCallStateDriver(); } break;
        default: console.warn(`[DriverJS] Tipe payload sinyal WebRTC tidak dikenal '${payload.type}' dari ${fromId}`);
    }
}

function resetCallStateDriver() {
    console.log('[DriverJS] Mereset status panggilan WebRTC...');
    iceCandidateQueue = [];
    if (localStreamDriver) { localStreamDriver.getTracks().forEach(track => track.stop()); localStreamDriver = null; }
    if (peerConnectionDriver) {
        peerConnectionDriver.onicecandidate = null; peerConnectionDriver.ontrack = null; peerConnectionDriver.onconnectionstatechange = null; peerConnectionDriver.oniceconnectionstatechange = null;
        if (peerConnectionDriver.signalingState !== "closed") peerConnectionDriver.close();
        peerConnectionDriver = null;
    }
    if (localVideoDriver) localVideoDriver.srcObject = null;
    if (remoteVideoDriver) remoteVideoDriver.srcObject = null;
    if (callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menunggu panggilan...';

    const wasCallActive = isWebRTCCallActive;
    currentCallerId = null;
    isWebRTCCallActive = false; 

    if (wasCallActive) {
        console.log("[DriverJS] Panggilan WebRTC berakhir, meminta Python mengambil kamera kembali...");
        if (opencvSocket && opencvSocket.connected) {
            opencvSocket.emit('request_camera_acquire', { driver_id: myDriverId });
        } else { console.warn('[DriverJS] opencvSocket tidak terhubung saat akan request_camera_acquire.'); }
        resumeOpenCVDetection(); 
    } else {
        if (!isWebRTCCallActive && (!opencvSocket || !opencvSocket.connected)) {
            console.log("[DriverJS] Memastikan deteksi OpenCV berjalan (tidak ada panggilan aktif & koneksi OpenCV terputus).");
            resumeOpenCVDetection();
        }
    }
}

function connectOpenCVDataStream() {
    if (isWebRTCCallActive) { console.log("[DriverJS] Panggilan WebRTC aktif, koneksi OpenCV ditunda."); return; }
    if (opencvSocket && opencvSocket.connected) { console.log("[DriverJS] Koneksi OpenCV Socket.IO sudah aktif."); return; }
    const calculatedOpenCVSocketURL = `http://${OPENCV_SERVER_HOST}:${OPENCV_SERVER_PORT}`;
    console.log(`[DriverJS] Mencoba terhubung ke OpenCV Socket.IO di: ${calculatedOpenCVSocketURL}`);
    if (typeof io === "undefined") { console.error("[DriverJS] Pustaka Socket.IO (io) tidak ditemukan!"); if(systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Error: io() lib hilang'; systemStatusOpenCVEl.className = 'status-error';} return; }
    opencvSocket = io.connect(calculatedOpenCVSocketURL, { reconnectionAttempts: 3, reconnectionDelay: 4000, timeout: 5000 });
    opencvSocket.on('connect', () => {
        if (isWebRTCCallActive) { console.log("[DriverJS] Terhubung OpenCV, tapi WebRTC aktif. Putuskan OpenCV."); opencvSocket.disconnect(); return; }
        console.log('[DriverJS] ✅ Terhubung ke server OpenCV (Python)');
        if (systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Terhubung. Menunggu kalibrasi kamera...'; systemStatusOpenCVEl.className = 'status-calibrating'; }
    });
    opencvSocket.on('disconnect', (reason) => {
        console.log('[DriverJS] ❌ Terputus dari server OpenCV (Python):', reason);
        if (systemStatusOpenCVEl && !isWebRTCCallActive) { systemStatusOpenCVEl.textContent = 'Koneksi Deteksi Terputus'; systemStatusOpenCVEl.className = 'status-error'; }
    });
    opencvSocket.on('connect_error', (err) => {
        console.error('[DriverJS] ❌ Error koneksi OpenCV (Python):', err);
        if (systemStatusOpenCVEl && !isWebRTCCallActive) { systemStatusOpenCVEl.textContent = `Gagal Hub. Deteksi (${err.type||err.message||''})`; systemStatusOpenCVEl.className = 'status-error'; }
    });
    opencvSocket.on('status_update', (data) => {
        if (isWebRTCCallActive) return;
        if (!systemStatusOpenCVEl || !calibrationStatusOpenCVEl || !alertMessageOpenCVEl || !thresholdValueOpenCVEl || !earValueOpenCVEl || !perclosValueOpenCVEl) return;
        if (data.message) {
            if (data.type === 'error') { systemStatusOpenCVEl.textContent = data.message; systemStatusOpenCVEl.className = 'status-error'; setOpenCVAlertMessage(data.message, 'error'); }
            else if (data.type === 'calibration_info') { systemStatusOpenCVEl.textContent = data.message; systemStatusOpenCVEl.className = 'status-calibrating'; if(calibrationStatusOpenCVEl) calibrationStatusOpenCVEl.textContent = 'Sedang Berlangsung'; }
            else if (data.type === 'calibration_done') { systemStatusOpenCVEl.textContent = 'OpenCV Terkalibrasi & Memantau'; systemStatusOpenCVEl.className = 'status-monitoring'; if(calibrationStatusOpenCVEl) calibrationStatusOpenCVEl.textContent = 'Selesai'; setOpenCVAlertMessage(data.message || 'Kalibrasi Selesai!', 'normal'); }
            else if (data.type === 'no_face') { 
                systemStatusOpenCVEl.textContent = data.message; systemStatusOpenCVEl.className = 'status-no-face'; 
                if(earValueOpenCVEl) earValueOpenCVEl.textContent = '-'; 
                if(perclosValueOpenCVEl) perclosValueOpenCVEl.textContent = '-';
                if(thresholdValueOpenCVEl) thresholdValueOpenCVEl.textContent = '-';
            } else { systemStatusOpenCVEl.textContent = data.message; }
        }
        if (data.is_calibrated !== undefined && calibrationStatusOpenCVEl) { calibrationStatusOpenCVEl.textContent = data.is_calibrated ? 'Selesai' : (systemStatusOpenCVEl.className.includes('calibrating') ? 'Sedang Berlangsung' : 'Belum');}
        if (data.dynamic_threshold !== undefined && thresholdValueOpenCVEl) { 
            thresholdValueOpenCVEl.textContent = formatOpenCVValue(data.dynamic_threshold, 3); 
        } else if (thresholdValueOpenCVEl && !data.is_calibrated) { thresholdValueOpenCVEl.textContent = '-'; }
    });
    opencvSocket.on('update_data', (data) => {
        if (isWebRTCCallActive) return;
        if (!earValueOpenCVEl || !perclosValueOpenCVEl || !calibrationStatusOpenCVEl || !thresholdValueOpenCVEl || !systemStatusOpenCVEl || !alertMessageOpenCVEl) return;
        
        const faceImpliedByData = (data.ear != null && data.ear !== -1);
        earValueOpenCVEl.textContent = formatOpenCVValue(data.ear, 3);
        perclosValueOpenCVEl.textContent = formatOpenCVValue(data.perclos !== null && data.perclos !== -1 ? (Number(data.perclos) * 100) : -1, 1, '-') + (data.perclos !== null && data.perclos !== -1 ? '%' : '');
        
        if (data.is_calibrated !== undefined && calibrationStatusOpenCVEl) { calibrationStatusOpenCVEl.textContent = data.is_calibrated ? 'Selesai' : (systemStatusOpenCVEl.className.includes('calibrating') ? 'Sedang Berlangsung' : 'Belum'); }
        
        if (data.dynamic_threshold !== undefined && data.dynamic_threshold !== null && thresholdValueOpenCVEl) { 
            thresholdValueOpenCVEl.textContent = formatOpenCVValue(data.dynamic_threshold, 3); 
        } else if (thresholdValueOpenCVEl && !data.is_calibrated) { thresholdValueOpenCVEl.textContent = '-'; }

        const currentAlertClasses = alertMessageOpenCVEl ? alertMessageOpenCVEl.className : '';
        if (systemStatusOpenCVEl && !currentAlertClasses.includes('alert-critical') && !currentAlertClasses.includes('alert-warning')) {
            if (faceImpliedByData) {
                if (data.is_calibrated) {
                    if (!systemStatusOpenCVEl.className.includes('status-monitoring')) { 
                        systemStatusOpenCVEl.textContent = 'OpenCV Memantau...'; 
                        systemStatusOpenCVEl.className = 'status-monitoring';
                    }
                } else { 
                    if (!systemStatusOpenCVEl.className.includes('status-calibrating')) {
                        systemStatusOpenCVEl.textContent = 'Kalibrasi OpenCV...'; 
                        systemStatusOpenCVEl.className = 'status-calibrating';
                    }
                }
            }
            // Jika !faceImpliedByData, status 'no_face' akan dihandle oleh event 'status_update' dari Python
        }
    });
    opencvSocket.on('drowsiness_alert', (data) => {
        if (isWebRTCCallActive) { console.log("[DriverJS] Panggilan WebRTC aktif, alert kantuk OpenCV diabaikan."); return; }
        console.log('[DriverJS] 🚨 Drowsiness Alert (OpenCV Diterima dari Python):', data);
        setOpenCVAlertMessage(data.message, data.type);
        if (data.type === 'alert') {
            if(systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'KANTUK OPENCV TERDETEKSI!'; systemStatusOpenCVEl.className = 'status-error';}
            if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN && myDriverId) {
                webrtcWebsocket.send(JSON.stringify({ type: 'driver_drowsy_notification', driver_id: myDriverId, original_opencv_message: data.message, timestamp: new Date().toISOString() }));
            }
        } else if (data.type === 'normal') {
            if(systemStatusOpenCVEl && data.is_calibrated) { systemStatusOpenCVEl.textContent = 'OpenCV Memantau...'; systemStatusOpenCVEl.className = 'status-monitoring';}
            else if (systemStatusOpenCVEl) { systemStatusOpenCVEl.textContent = 'Kalibrasi OpenCV...'; systemStatusOpenCVEl.className = 'status-calibrating';}
            if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN && myDriverId) {
                 webrtcWebsocket.send(JSON.stringify({ type: 'driver_normal_notification', driver_id: myDriverId, timestamp: new Date().toISOString() }));
            }
        }
    });
}

function formatOpenCVValue(value, precision = 3, defaultValue = '-') { return (value != null && value !== -1 && !isNaN(Number(value))) ? Number(value).toFixed(precision) : defaultValue; }
function setOpenCVAlertMessage(message, type) { if (!alertMessageOpenCVEl) return; alertMessageOpenCVEl.textContent = message; alertMessageOpenCVEl.className = 'alert-message-opencv'; if (type === 'alert' || type === 'error') alertMessageOpenCVEl.classList.add('alert-critical'); else if (type === 'warning') alertMessageOpenCVEl.classList.add('alert-warning'); else alertMessageOpenCVEl.classList.add('alert-normal'); }

document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Inisialisasi Driver.js');
    if (opencvVideoFeedEl) {
        opencvFeedActualURL = OPENCV_VIDEO_FEED_BASE_URL + '?_cachebust=' + new Date().getTime();
        console.log(`[DriverJS DEBUG] DOMContentLoaded: OPENCV_SERVER_HOST=${OPENCV_SERVER_HOST}, OPENCV_SERVER_PORT=${OPENCV_SERVER_PORT}`);
        console.log(`[DriverJS DEBUG] DOMContentLoaded: OPENCV_VIDEO_FEED_BASE_URL=${OPENCV_VIDEO_FEED_BASE_URL}`);
        console.log(`[DriverJS] URL awal OpenCV video feed: ${opencvFeedActualURL}`);
        if (!isWebRTCCallActive) { opencvVideoFeedEl.src = opencvFeedActualURL; opencvVideoFeedEl.style.display = 'block'; } 
        else { opencvVideoFeedEl.style.display = 'none'; }
        opencvVideoFeedEl.onerror = () => {
            console.error(`[DriverJS] ❌ Gagal load OpenCV video feed dari ${opencvVideoFeedEl.src || opencvFeedActualURL}. Periksa server Python dan URL.`);
            if (systemStatusOpenCVEl && !isWebRTCCallActive) { systemStatusOpenCVEl.textContent = 'Gagal load video OpenCV.'; systemStatusOpenCVEl.className = 'status-error'; }
            if (opencvVideoFeedEl && !isWebRTCCallActive) { opencvVideoFeedEl.alt = `Error load video. URL: ${opencvFeedActualURL || 'N/A'}`; }
        };
        opencvVideoFeedEl.onload = () => { if (!isWebRTCCallActive) console.log('[DriverJS] ✅ OpenCV video feed dimuat.'); };
    } else { console.warn("[DriverJS] Elemen opencvVideoFeedEl tidak ditemukan."); }
    if (!isWebRTCCallActive) { connectOpenCVDataStream(); }
    console.log('[DriverJS] ✅ Inisialisasi Driver.js selesai');
});

window.addEventListener('beforeunload', () => {
    console.log('[DriverJS] 🔄 Membersihkan sebelum halaman ditutup...');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (isWebRTCCallActive && currentCallerId && webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN) {
        sendSignalToNodeJs(currentCallerId, { type: 'call_ended', reason: 'driver_closed_browser_unexpectedly' });
    }
    if (isWebRTCCallActive || peerConnectionDriver) { resetCallStateDriver(); }
    if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN) webrtcWebsocket.close();
    if (opencvSocket && opencvSocket.connected) opencvSocket.disconnect();
});