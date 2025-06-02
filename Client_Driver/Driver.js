// File: Client_Driver/Driver.js
// PERBAIKAN UNTUK MASALAH PANGGILAN SUPERVISOR KE DRIVER

// =====================================================================================
// KONFIGURASI SERVER
// =====================================================================================
const OPENCV_SERVER_HOST = 'localhost'; 
const OPENCV_SERVER_PORT = '5000';

const WEBRTC_SERVER_HOST = location.hostname; 
const WEBRTC_SERVER_PORT = '8080'; 
const WEBRTC_WS_URL = `ws://${WEBRTC_SERVER_HOST}:${WEBRTC_SERVER_PORT}/ws-webrtc`;

const OPENCV_SOCKETIO_URL = `http://${OPENCV_SERVER_HOST}:${OPENCV_SERVER_PORT}`;
const OPENCV_VIDEO_FEED_BASE_URL = `http://${OPENCV_SERVER_HOST}:${OPENCV_SERVER_PORT}/video_feed`;
// =====================================================================================

let webrtcWebsocket;
let peerConnectionDriver;
let localStreamDriver;
let myDriverId = null;
let currentCallerId = null;
let opencvSocket;
let iceCandidateQueue = []; // PERBAIKAN 1: Queue untuk ICE candidates

// --- Elemen DOM ---
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

// PERBAIKAN 2: Tambahkan heartbeat untuk menjaga koneksi
let heartbeatInterval;

// =====================================================================================
// BAGIAN WEBRTC
// =====================================================================================
const iceServersDriver = { 
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' } // PERBAIKAN 3: Tambah STUN server cadangan
    ]
};

if (registerDriverBtn) {
    registerDriverBtn.onclick = () => {
        console.log("Tombol 'Daftar ke Sistem WebRTC' diklik!");
        if(!driverIdInput || !registrationStatusUI) {
            console.error("Elemen DOM untuk registrasi tidak ditemukan!"); 
            return;
        }
        myDriverId = driverIdInput.value.trim();
        if (myDriverId) {
            registrationStatusUI.textContent = `Mencoba mendaftar WebRTC sebagai ${myDriverId}...`;
            connectWebRTCWebSocket();
        } else {
            registrationStatusUI.textContent = 'ID Driver WebRTC tidak boleh kosong.';
        }
    };
} else { 
    console.error("Tombol 'registerDriverBtn' tidak ditemukan!"); 
}

function connectWebRTCWebSocket() {
    // PERBAIKAN 4: Clear heartbeat interval yang lama
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }

    // Tutup koneksi lama jika ada
    if (webrtcWebsocket && (webrtcWebsocket.readyState === WebSocket.OPEN || webrtcWebsocket.readyState === WebSocket.CONNECTING)) {
        console.log("Menutup koneksi WebRTC WS lama sebelum membuka yang baru.");
        webrtcWebsocket.onopen = null; 
        webrtcWebsocket.onmessage = null;
        webrtcWebsocket.onerror = null;
        webrtcWebsocket.onclose = null;
        webrtcWebsocket.close();
    }
    
    console.log(`Mencoba koneksi WebRTC WS ke: ${WEBRTC_WS_URL}`);
    webrtcWebsocket = new WebSocket(WEBRTC_WS_URL);

    webrtcWebsocket.onopen = () => {
        console.log(`Terhubung ke Server WebRTC (${WEBRTC_WS_URL}) dengan ID Driver: ${myDriverId}`);
        if (myDriverId) {
            webrtcWebsocket.send(JSON.stringify({ 
                type: 'register_driver', 
                driver_id: myDriverId 
            }));
            
            // PERBAIKAN 5: Setup heartbeat untuk menjaga koneksi
            heartbeatInterval = setInterval(() => {
                if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN) {
                    webrtcWebsocket.send(JSON.stringify({ 
                        type: 'ping', 
                        driver_id: myDriverId 
                    }));
                }
            }, 30000); // Ping setiap 30 detik
            
        } else {
            console.error("Driver ID kosong saat mencoba mengirim pesan register_driver.");
            if (registrationStatusUI) registrationStatusUI.textContent = 'Registrasi gagal: ID Driver kosong.';
        }
    };

    webrtcWebsocket.onerror = (error) => {
        console.error('WebSocket Error (WebRTC Driver):', error);
        if (registrationStatusUI) registrationStatusUI.textContent = 'Gagal terhubung ke server WebRTC.';
        
        // PERBAIKAN 6: Clear heartbeat saat error
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    };

    webrtcWebsocket.onclose = (event) => {
        console.log('Koneksi WebRTC WS Driver terputus. Kode:', event.code, 'Alasan:', event.reason);
        
        // PERBAIKAN 7: Clear heartbeat saat close
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        
        const isRegistered = registrationStatusUI && registrationStatusUI.textContent.includes("Terdaftar di WebRTC");
        
        if (registrationPanel && callPanel && 
            (!isRegistered || (callPanel.style.display === 'none' && registrationPanel.style.display !== 'block'))) {
            
            registrationPanel.style.display = 'block';
            callPanel.style.display = 'none';
            if (registrationStatusUI && !isRegistered) {
                 registrationStatusUI.textContent = "Koneksi WebRTC terputus. Silakan daftar ulang.";
            }
        } else if (callStatusDriverUI && isRegistered && callPanel.style.display !== 'none') {
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
                console.log(`✅ Driver ${data.driver_id} berhasil terdaftar di server WebRTC`);
                if (registrationStatusUI) registrationStatusUI.textContent = `Terdaftar di WebRTC sebagai ${data.driver_id}.`;
                if (registrationPanel) registrationPanel.style.display = 'none';
                if (callPanel) callPanel.style.display = 'block';
                if (callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menunggu panggilan...';
                break;
                
            case 'incoming_call': 
                console.log(`📞 Panggilan masuk dari supervisor: ${data.from_supervisor_id}`);
                handleIncomingCall(data.from_supervisor_id); 
                break;
                
            case 'webrtc_signal': 
                handleWebRTCSignalDriver(data); 
                break;
                
            case 'pong':
                console.log('Pong diterima dari server WebRTC');
                break;
                
            case 'error':
                console.error('Error dari server WebRTC:', data.message);
                if (registrationStatusUI) registrationStatusUI.textContent = `Error WebRTC: ${data.message}`;
                if (data.message && data.message.toLowerCase().includes("id driver sudah digunakan")) {
                    if (registrationPanel) registrationPanel.style.display = 'block';
                    if (callPanel) callPanel.style.display = 'none';
                }
                break;
                
            case 'webrtc_signal_failed':
                console.error('Sinyal WebRTC gagal:', data.reason);
                alert(`Gagal memproses panggilan: ${data.reason}.`);
                if (["offer", "answer"].includes(data.original_payload_type)) resetCallStateDriver();
                break;
                
            case 'call_failed':
                console.error('Panggilan gagal:', data.reason);
                alert(`Panggilan gagal dari server: ${data.reason}`);
                resetCallStateDriver();
                break;
                
            default: 
                console.warn("Driver menerima pesan WebRTC tipe tidak dikenal:", data);
        }
    };
}

function handleIncomingCall(fromSupervisorId) {
    console.log(`📞 Panggilan WebRTC masuk dari Supervisor: ${fromSupervisorId}`);
    
    // PERBAIKAN 8: Cek status peer connection lebih detail
    if (peerConnectionDriver && 
        !['closed', 'failed'].includes(peerConnectionDriver.signalingState) && 
        !['closed', 'failed'].includes(peerConnectionDriver.connectionState)) {
        
        console.log('⚠️ Driver sedang dalam panggilan, menolak panggilan baru');
        if (webrtcWebsocket && fromSupervisorId) {
            webrtcWebsocket.send(JSON.stringify({ 
                type: 'webrtc_signal', 
                target_id: fromSupervisorId, 
                payload: { 
                    type: 'call_busy', 
                    reason: 'driver_in_another_call' 
                }
            }));
        }
        return;
    }
    
    // Reset state jika ada peer connection lama yang rusak
    if (peerConnectionDriver) {
        console.log('🔄 Reset peer connection lama sebelum menerima panggilan baru');
        resetCallStateDriver();
    }
    
    currentCallerId = fromSupervisorId;
    if(callerIdTextUI) callerIdTextUI.textContent = fromSupervisorId ? fromSupervisorId.substring(0,8) : 'Supervisor';
    if(incomingCallAlertUI) incomingCallAlertUI.style.display = 'block';
    if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Panggilan masuk...';
    
    // PERBAIKAN 9: Set timeout untuk panggilan masuk
    const callTimeout = setTimeout(() => {
        if (incomingCallAlertUI && incomingCallAlertUI.style.display === 'block') {
            console.log('⏰ Timeout panggilan masuk');
            rejectCall(fromSupervisorId, 'call_timeout');
        }
    }, 30000); // 30 detik timeout
    
    if(acceptCallBtn) {
        acceptCallBtn.onclick = () => {
            clearTimeout(callTimeout);
            acceptCall(fromSupervisorId);
        };
    }
    if(rejectCallBtn) {
        rejectCallBtn.onclick = () => {
            clearTimeout(callTimeout);
            rejectCall(fromSupervisorId, 'driver_rejected_call');
        };
    }
}

async function acceptCall(callerId) {
    console.log(`✅ Menerima panggilan WebRTC dari ${callerId}`);
    if(incomingCallAlertUI) incomingCallAlertUI.style.display = 'none';
    if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menerima panggilan...';
    currentCallerId = callerId;
    
    // PERBAIKAN 10: Reset ICE candidate queue
    iceCandidateQueue = [];
    
    try {
        // PERBAIKAN 11: Lebih spesifik dengan constraints media
        const mediaConstraints = { 
            video: { 
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 15, max: 30 }
            }, 
            audio: {
                echoCancellation: true,
                noiseSuppression: true
            }
        };
        
        localStreamDriver = await navigator.mediaDevices.getUserMedia(mediaConstraints);
        if(localVideoDriver) {
            localVideoDriver.srcObject = localStreamDriver;
            localVideoDriver.muted = true; // Prevent feedback
        }
        
        console.log('✅ Media lokal berhasil didapatkan');
        
    } catch (error) {
        console.error('❌ Error mendapatkan media lokal (Driver WebRTC):', error);
        if(callStatusDriverUI) callStatusDriverUI.textContent = 'Error WebRTC: Gagal akses kamera/mikrofon.';
        if (webrtcWebsocket && currentCallerId) {
             webrtcWebsocket.send(JSON.stringify({ 
                type: 'webrtc_signal', 
                target_id: currentCallerId, 
                payload: { 
                    type: 'call_rejected', 
                    reason: 'media_error_on_driver' 
                }
            }));
        }
        resetCallStateDriver(); 
        return;
    }
    
    // Reset peer connection jika sudah ada
    if (peerConnectionDriver) resetCallStateDriver(); 
    
    // PERBAIKAN 12: Tambah konfigurasi RTCPeerConnection yang lebih robust
    const rtcConfig = {
        ...iceServersDriver,
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
    };
    
    peerConnectionDriver = new RTCPeerConnection(rtcConfig);
    
    // Tambahkan track media lokal
    if (localStreamDriver) { 
        localStreamDriver.getTracks().forEach(track => {
            console.log(`➕ Menambahkan track: ${track.kind}`);
            peerConnectionDriver.addTrack(track, localStreamDriver);
        });
    }
    
    // PERBAIKAN 13: Handle ICE candidates dengan queue
    peerConnectionDriver.onicecandidate = event => {
        if (event.candidate) {
            console.log('🧊 ICE candidate generated:', event.candidate.type);
            if (webrtcWebsocket && currentCallerId && webrtcWebsocket.readyState === WebSocket.OPEN) {
                webrtcWebsocket.send(JSON.stringify({ 
                    type: 'webrtc_signal', 
                    target_id: currentCallerId, 
                    payload: { 
                        type: 'candidate', 
                        candidate: event.candidate 
                    }
                }));
            } else {
                console.warn('⚠️ Tidak bisa kirim ICE candidate, simpan di queue');
                iceCandidateQueue.push(event.candidate);
            }
        } else {
            console.log('🧊 ICE gathering selesai');
        }
    };
    
    peerConnectionDriver.ontrack = event => { 
        console.log('📹 Remote track diterima:', event.streams[0]);
        if(remoteVideoDriver) remoteVideoDriver.srcObject = event.streams[0]; 
    };
    
    peerConnectionDriver.onconnectionstatechange = event => {
        if(!peerConnectionDriver) return;
        const state = peerConnectionDriver.connectionState;
        console.log("🔄 Status koneksi Peer (Driver WebRTC):", state);
        
        if(callStatusDriverUI) {
            switch(state) {
                case 'connecting':
                    callStatusDriverUI.textContent = 'WebRTC: Menghubungkan...';
                    break;
                case 'connected':
                    callStatusDriverUI.textContent = 'WebRTC: Terhubung!';
                    break;
                case 'disconnected':
                    callStatusDriverUI.textContent = 'WebRTC: Terputus';
                    break;
                case 'failed':
                    callStatusDriverUI.textContent = 'WebRTC: Gagal terhubung';
                    break;
                case 'closed':
                    callStatusDriverUI.textContent = 'WebRTC: Panggilan berakhir';
                    break;
                default:
                    callStatusDriverUI.textContent = `WebRTC: ${state}`;
            }
        }
        
        if (['disconnected', 'failed', 'closed'].includes(state)) { 
            console.log('❌ Peer connection bermasalah, reset state');
            setTimeout(() => resetCallStateDriver(), 1000); // Delay reset untuk stabilitas
        }
    };
    
    // PERBAIKAN 14: Tambah ICE connection state change handler
    peerConnectionDriver.oniceconnectionstatechange = () => {
        if (!peerConnectionDriver) return;
        const iceState = peerConnectionDriver.iceConnectionState;
        console.log("🧊 ICE Connection State:", iceState);
        
        if (iceState === 'failed') {
            console.log('❌ ICE connection failed, mencoba restart ICE');
            peerConnectionDriver.restartIce();
        }
    };
    
    if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Siap menerima offer...'; 
}

function rejectCall(callerId, reason = 'driver_rejected_call') {
    console.log(`❌ Menolak panggilan dari ${callerId}, reason: ${reason}`);
    if(incomingCallAlertUI) incomingCallAlertUI.style.display = 'none';
    
    if (webrtcWebsocket && callerId && webrtcWebsocket.readyState === WebSocket.OPEN) {
        webrtcWebsocket.send(JSON.stringify({ 
            type: 'webrtc_signal', 
            target_id: callerId, 
            payload: { 
                type: 'call_rejected', 
                reason: reason 
            }
        }));
    }
    
    if(callStatusDriverUI) callStatusDriverUI.textContent = `WebRTC: Panggilan ditolak (${reason}).`;
    currentCallerId = null; 
    
    setTimeout(() => { 
        if(callStatusDriverUI && callStatusDriverUI.textContent.includes('ditolak')) {
            callStatusDriverUI.textContent = 'WebRTC: Menunggu panggilan...';
        }
    }, 3000);
}

async function handleWebRTCSignalDriver(data) {
    if (!data.from_id) { 
        console.error("❌ Sinyal WebRTC tanpa from_id:", data); 
        return; 
    }
    
    const payload = data.payload; 
    const fromId = data.from_id;
    console.log(`📡 Driver: Menerima sinyal WebRTC tipe '${payload.type}' dari ${fromId}`);

    if (payload.type === 'offer') {
        // PERBAIKAN 15: Handle offer dengan lebih baik
        if (!peerConnectionDriver) { 
            console.log('🔄 Tidak ada peer connection, accept call terlebih dahulu');
            currentCallerId = fromId; 
            await acceptCall(fromId); 
            if (!peerConnectionDriver) { 
                console.error("❌ Gagal memproses offer karena acceptCall tidak membuat PeerConnection.");
                return; 
            }
        } else if (currentCallerId && fromId !== currentCallerId) { 
            console.log(`⚠️ Offer dari ${fromId}, tapi panggilan aktif dengan ${currentCallerId}. Abaikan.`); 
            return; 
        }
        
        try {
            console.log('📥 Memproses offer dari supervisor');
            await peerConnectionDriver.setRemoteDescription(new RTCSessionDescription({ 
                type: 'offer', 
                sdp: payload.sdp 
            }));
            
            console.log('✅ Remote description (offer) berhasil di-set');
            
            // PERBAIKAN 16: Process queued ICE candidates setelah set remote description
            if (iceCandidateQueue.length > 0) {
                console.log(`🧊 Memproses ${iceCandidateQueue.length} ICE candidates dari queue`);
                for (const candidate of iceCandidateQueue) {
                    try {
                        await peerConnectionDriver.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (error) {
                        console.error('❌ Error menambah queued ICE candidate:', error);
                    }
                }
                iceCandidateQueue = [];
            }
            
            const answer = await peerConnectionDriver.createAnswer();
            await peerConnectionDriver.setLocalDescription(answer);
            
            console.log('📤 Mengirim answer ke supervisor');
            if (webrtcWebsocket && fromId && webrtcWebsocket.readyState === WebSocket.OPEN) {
                webrtcWebsocket.send(JSON.stringify({ 
                    type: 'webrtc_signal', 
                    target_id: fromId, 
                    payload: { 
                        type: 'answer', 
                        sdp: answer.sdp 
                    }
                }));
                console.log('✅ Answer berhasil dikirim');
            } else {
                console.error('❌ Tidak bisa mengirim answer: WebSocket tidak terhubung');
            }
            
            if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Menunggu koneksi...';
            
        } catch (error) { 
            console.error('❌ Error memproses offer atau membuat answer:', error); 
            if(callStatusDriverUI) callStatusDriverUI.textContent = 'WebRTC: Error memproses panggilan';
            resetCallStateDriver();
        }

    } else if (payload.type === 'candidate') {
        if (peerConnectionDriver && peerConnectionDriver.remoteDescription) {
            try { 
                console.log('🧊 Menambah ICE candidate dari supervisor');
                await peerConnectionDriver.addIceCandidate(new RTCIceCandidate(payload.candidate)); 
            }
            catch (error) { 
                console.error('❌ Error menambah ICE candidate (Driver):', error); 
            }
        } else { 
            console.warn("⚠️ Menerima ICE candidate sebelum remoteDescription siap, simpan di queue");
            iceCandidateQueue.push(payload.candidate);
        }
        
    } else if (payload.type === 'call_cancelled_by_supervisor') { 
        console.log("❌ Panggilan dibatalkan oleh supervisor sebelum dijawab.");
        alert(`Panggilan dari ${fromId ? fromId.substring(0,8) : 'supervisor'} dibatalkan.`);
        resetCallStateDriver();
        if(incomingCallAlertUI) incomingCallAlertUI.style.display = 'none';
        
    } else if (payload.type === 'call_rejected' || payload.type === 'call_ended_by_supervisor' || payload.type === 'call_busy') {
        console.log(`❌ Panggilan berakhir: ${payload.type}, reason: ${payload.reason}`);
        resetCallStateDriver(); 
        if(callStatusDriverUI) callStatusDriverUI.textContent = `WebRTC: ${payload.reason || 'Panggilan berakhir'}`;
        
        setTimeout(() => {
            if(callStatusDriverUI && callStatusDriverUI.textContent.includes('berakhir')) {
                callStatusDriverUI.textContent = 'WebRTC: Menunggu panggilan...';
            }
        }, 3000);
    }
}

function resetCallStateDriver() {
    console.log('🔄 Reset call state driver');
    
    // PERBAIKAN 17: Reset ICE candidate queue
    iceCandidateQueue = [];
    
    if (localStreamDriver) { 
        localStreamDriver.getTracks().forEach(track => {
            console.log(`⏹️ Stopping track: ${track.kind}`);
            track.stop();
        }); 
        localStreamDriver = null; 
    }
    
    if (peerConnectionDriver) { 
        // Remove all event handlers to prevent memory leaks
        peerConnectionDriver.onicecandidate = null; 
        peerConnectionDriver.ontrack = null; 
        peerConnectionDriver.onconnectionstatechange = null;
        peerConnectionDriver.oniceconnectionstatechange = null;
        
        if (peerConnectionDriver.signalingState !== "closed") {
            console.log('🔒 Menutup peer connection');
            peerConnectionDriver.close(); 
        }
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
        if(systemStatusOpenCVEl) { 
            systemStatusOpenCVEl.textContent = 'Error: Pustaka io()'; 
            systemStatusOpenCVEl.className = 'status-error';
        }
        return;
    }
    
    opencvSocket = io.connect(OPENCV_SOCKETIO_URL, { 
        reconnectionAttempts: 5, 
        reconnectionDelay: 3000 
    });
    
    opencvSocket.on('connect', () => {
        console.log('✅ Terhubung ke server OpenCV');
        if(systemStatusOpenCVEl) { 
            systemStatusOpenCVEl.textContent = 'Terhubung OpenCV. Menunggu kamera...'; 
            systemStatusOpenCVEl.className = 'status-calibrating';
        }
    });
    
    opencvSocket.on('disconnect', (reason) => {
        console.log('❌ Terputus dari server OpenCV:', reason);
        if(systemStatusOpenCVEl) { 
            systemStatusOpenCVEl.textContent = 'Koneksi OpenCV Terputus'; 
            systemStatusOpenCVEl.className = 'status-error';
        }
        if(alertMessageOpenCVEl) setOpenCVAlertMessage('Koneksi server deteksi terputus!', 'error');
    });
    
    opencvSocket.on('connect_error', (err) => {
        console.error('❌ Error koneksi OpenCV:', err);
        if(systemStatusOpenCVEl) { 
            systemStatusOpenCVEl.textContent = 'Gagal Hub. Deteksi OpenCV'; 
            systemStatusOpenCVEl.className = 'status-error';
        }
        if(alertMessageOpenCVEl) setOpenCVAlertMessage(`Gagal hub. server deteksi di ${OPENCV_SOCKETIO_URL}. Error: ${err.message}`, 'error');
    });
    
    opencvSocket.on('status_update', (data) => {
        if (!systemStatusOpenCVEl || !calibrationStatusOpenCVEl || !alertMessageOpenCVEl || !thresholdValueOpenCVEl || !earValueOpenCVEl || !perclosValueOpenCVEl) return;
        
        if (data.message) {
            if (data.type === 'error') { 
                systemStatusOpenCVEl.textContent = data.message; 
                systemStatusOpenCVEl.className = 'status-error'; 
                setOpenCVAlertMessage(data.message, 'error'); 
            }
            else if (data.type === 'calibration_info') { 
                systemStatusOpenCVEl.textContent = data.message; 
                systemStatusOpenCVEl.className = 'status-calibrating'; 
                calibrationStatusOpenCVEl.textContent = 'Sedang Berlangsung'; 
            }
            else if (data.type === 'calibration_done') { 
                systemStatusOpenCVEl.textContent = 'OpenCV Terkalibrasi & Memantau'; 
                systemStatusOpenCVEl.className = 'status-monitoring'; 
                calibrationStatusOpenCVEl.textContent = 'Selesai'; 
                setOpenCVAlertMessage(data.message || 'Kalibrasi Selesai!', 'normal'); 
            }
            else if (data.type === 'no_face') { 
                systemStatusOpenCVEl.textContent = data.message; 
                systemStatusOpenCVEl.className = 'status-no-face'; 
                earValueOpenCVEl.textContent = '-'; 
                perclosValueOpenCVEl.textContent = '-';
            }
            else { 
                systemStatusOpenCVEl.textContent = data.message; 
            }
        }
        
        if (data.is_calibrated !== undefined) {
            calibrationStatusOpenCVEl.textContent = data.is_calibrated ? 'Selesai' : (systemStatusOpenCVEl.className === 'status-calibrating' ? 'Sedang Berlangsung' : 'Belum');
        }
        
        if (data.dynamic_threshold !== undefined) {
            thresholdValueOpenCVEl.textContent = formatOpenCVValue(data.dynamic_threshold, 3);
        }
    });
    
    opencvSocket.on('update_data', (data) => {
        if (!earValueOpenCVEl || !perclosValueOpenCVEl || !calibrationStatusOpenCVEl || !thresholdValueOpenCVEl || !alertMessageOpenCVEl || !systemStatusOpenCVEl) return;
        
        earValueOpenCVEl.textContent = formatOpenCVValue(data.ear, 3);
        perclosValueOpenCVEl.textContent = formatOpenCVValue(data.perclos !== -1 ? (Number(data.perclos) * 100) : -1, 1, '-') + (data.perclos !== -1 && data.perclos != null ? '%' : '');
        
        if (data.is_calibrated !== undefined) {
            calibrationStatusOpenCVEl.textContent = data.is_calibrated ? 'Selesai' : (systemStatusOpenCVEl.className === 'status-calibrating' ? 'Sedang Berlangsung' : 'Belum');
        }
        
        if (data.dynamic_threshold !== undefined) {
            thresholdValueOpenCVEl.textContent = formatOpenCVValue(data.dynamic_threshold, 3);
        }
        
        const currentAlertClasses = alertMessageOpenCVEl.className;
        if (!currentAlertClasses.includes('alert-critical') && !currentAlertClasses.includes('alert-warning') && systemStatusOpenCVEl.className !== 'status-no-face') {
            if (data.is_calibrated) { 
                if (!systemStatusOpenCVEl.textContent.includes("Memantau")) { 
                    systemStatusOpenCVEl.textContent = 'OpenCV Memantau...'; 
                    systemStatusOpenCVEl.className = 'status-monitoring'; 
                }
            }
            else { 
                if (!systemStatusOpenCVEl.textContent.includes("Kalibrasi")) { 
                    systemStatusOpenCVEl.textContent = 'Kalibrasi OpenCV...'; 
                    systemStatusOpenCVEl.className = 'status-calibrating';
                }
            }
        }
    });
    
    opencvSocket.on('drowsiness_alert', (data) => {
        if (!alertMessageOpenCVEl || !systemStatusOpenCVEl || !calibrationStatusOpenCVEl) return;
        
        console.log('🚨 Drowsiness Alert (OpenCV Diterima):', data);
        setOpenCVAlertMessage(data.message, data.type);
        
        if (data.type === 'alert') {
            systemStatusOpenCVEl.textContent = 'KANTUK OPENCV TERDETEKSI!'; 
            systemStatusOpenCVEl.className = 'status-error';
            
            // PERBAIKAN 18: Pastikan WebSocket terhubung sebelum mengirim notifikasi
            if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN && myDriverId) {
                console.log(`📤 Mengirim notifikasi kantuk untuk ${myDriverId} ke server WebRTC.`);
                webrtcWebsocket.send(JSON.stringify({ 
                    type: 'driver_drowsy_notification', 
                    driver_id: myDriverId, 
                    original_opencv_message: data.message,
                    timestamp: new Date().toISOString()
                }));
            } else { 
                console.warn("⚠️ Tidak bisa kirim notifikasi kantuk ke server WebRTC: WS tidak terhubung atau Driver ID belum terdaftar."); 
            }
            
        } else if (data.type === 'normal') {
            let isCalibrated = data.is_calibrated !== undefined ? data.is_calibrated : (calibrationStatusOpenCVEl.textContent === 'Selesai');
            
            if (isCalibrated) { 
                systemStatusOpenCVEl.textContent = 'OpenCV Memantau...'; 
                systemStatusOpenCVEl.className = 'status-monitoring';
            }
            else { 
                systemStatusOpenCVEl.textContent = 'Kalibrasi OpenCV...'; 
                systemStatusOpenCVEl.className = 'status-calibrating';
            }
            
            if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN && myDriverId) {
                webrtcWebsocket.send(JSON.stringify({ 
                    type: 'driver_normal_notification', 
                    driver_id: myDriverId,
                    timestamp: new Date().toISOString()
                }));
            }
        }
    });
}

// PERBAIKAN 19: Utility functions yang lebih robust
function formatOpenCVValue(value, precision = 3, defaultValue = '-') { 
    return (value != null && value !== -1 && !isNaN(Number(value))) ? Number(value).toFixed(precision) : defaultValue; 
}

function setOpenCVAlertMessage(message, type) {
    if (!alertMessageOpenCVEl) return;
    
    alertMessageOpenCVEl.textContent = message; 
    alertMessageOpenCVEl.className = 'alert-message-opencv';
    
    if (type === 'alert') {
        alertMessageOpenCVEl.classList.add('alert-critical');
    }
    else if (type === 'warning') {
        alertMessageOpenCVEl.classList.add('alert-warning');
    }
    else if (type === 'normal' || type === 'info' || type === 'calibration_done') {
        alertMessageOpenCVEl.classList.add('alert-normal');
    }
    else if (type === 'error') {
        alertMessageOpenCVEl.classList.add('alert-critical');
    }
    else {
        alertMessageOpenCVEl.classList.add('alert-normal');
    }
}

// PERBAIKAN 20: Tambahkan function untuk debug dan monitoring
function getSystemStatus() {
    return {
        webrtc: {
            connected: webrtcWebsocket ? webrtcWebsocket.readyState === WebSocket.OPEN : false,
            driverId: myDriverId,
            currentCallerId: currentCallerId,
            peerConnectionState: peerConnectionDriver ? peerConnectionDriver.connectionState : null,
            signalingState: peerConnectionDriver ? peerConnectionDriver.signalingState : null
        },
        opencv: {
            connected: opencvSocket ? opencvSocket.connected : false
        },
        media: {
            localStream: localStreamDriver ? localStreamDriver.getTracks().length : 0,
            remoteStream: remoteVideoDriver && remoteVideoDriver.srcObject ? 'active' : 'inactive'
        }
    };
}

// PERBAIKAN 21: Tambahkan window error handler
window.addEventListener('error', (event) => {
    console.error('❌ Global Error:', event.error);
    if (event.error && event.error.message && event.error.message.includes('WebRTC')) {
        if (callStatusDriverUI) {
            callStatusDriverUI.textContent = 'WebRTC: Error sistem, silakan refresh halaman';
        }
    }
});

// PERBAIKAN 22: Tambahkan unload handler untuk cleanup
window.addEventListener('beforeunload', () => {
    console.log('🔄 Cleaning up sebelum page unload');
    
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    
    if (peerConnectionDriver) {
        resetCallStateDriver();
    }
    
    if (webrtcWebsocket && webrtcWebsocket.readyState === WebSocket.OPEN) {
        webrtcWebsocket.close();
    }
    
    if (opencvSocket && opencvSocket.connected) {
        opencvSocket.disconnect();
    }
});

// INISIALISASI
document.addEventListener('DOMContentLoaded', (event) => {
    console.log('🚀 Inisialisasi Driver.js');
    
    // Connect to OpenCV data stream
    connectOpenCVDataStream();
    
    // Setup OpenCV video feed
    const opencvFeedImg = document.getElementById('opencvVideoFeed');
    if (opencvFeedImg) {
        const opencvFeedUrl = `${OPENCV_VIDEO_FEED_BASE_URL}?_cachebust=${new Date().getTime()}`;
        opencvFeedImg.src = opencvFeedUrl;
        
        opencvFeedImg.onerror = () => {
            console.error(`❌ Gagal memuat OpenCV video feed dari ${opencvFeedUrl}.`);
            if (systemStatusOpenCVEl) { 
                systemStatusOpenCVEl.textContent = 'Gagal load video OpenCV.'; 
                systemStatusOpenCVEl.className = 'status-error';
            }
            if (opencvVideoFeedEl) { 
                opencvVideoFeedEl.alt = `Error: Gagal load video dari ${opencvFeedUrl}. Server OpenCV tidak aktif/terjangkau.`;
            }
        };
        
        opencvFeedImg.onload = () => {
            console.log('✅ OpenCV video feed berhasil dimuat');
        };
    } else { 
        console.error("❌ Elemen gambar 'opencvVideoFeed' tidak ditemukan!"); 
    }
    
    // PERBAIKAN 23: Tambahkan debug info untuk development
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        console.log('🔧 Mode Development - Debug info tersedia');
        
        // Expose debug function to global scope
        window.getDriverSystemStatus = getSystemStatus;
        
        // Log system status setiap 30 detik
        setInterval(() => {
            console.log('📊 System Status:', getSystemStatus());
        }, 30000);
    }
    
    console.log('✅ Inisialisasi Driver.js selesai');
});