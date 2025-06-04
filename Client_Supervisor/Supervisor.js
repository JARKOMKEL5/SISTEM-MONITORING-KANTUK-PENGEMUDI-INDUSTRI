// File: Client_Supervisor/Supervisor.js
// (Versi terbaru dengan penanganan daftar driver yang lebih baik)

// =====================================================================================
// KONFIGURASI SERVER
// =====================================================================================
const WEBRTC_SERVER_HOST_SUPERVISOR = location.hostname;
const WEBRTC_SERVER_PORT_SUPERVISOR = '8080';
const WEBRTC_SUPERVISOR_WS_URL = `ws://${WEBRTC_SERVER_HOST_SUPERVISOR}:${WEBRTC_SERVER_PORT_SUPERVISOR}`;
// =====================================================================================

let supervisorWebsocket;
let peerConnections = {};
let localStreamSupervisor;
let currentCallingDriver = null;
let driverStatuses = new Map();
let connectionRetryCount = 0;
const MAX_RETRY_COUNT = 5;

const driverListUI = document.getElementById('driverList');
const supervisorAlertsListUI = document.getElementById('supervisorAlertsList');
const localVideoSupervisor = document.getElementById('localVideoSupervisor');
const remoteVideoSupervisor = document.getElementById('remoteVideoSupervisor');
const callStatusSupervisorUI = document.getElementById('callStatusSupervisor');
const currentCallingDriverIdUI = document.getElementById('currentCallingDriverId');
const cancelCallBtnSupervisor = document.getElementById('cancelCallBtnSupervisor');
const supervisorLogPanel = document.getElementById('supervisorLogPanel');

const iceServersSupervisor = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let supervisorLogMessages = [];
const MAX_LOG_MESSAGES = 100;
let callTimeoutId = null;
let heartbeatInterval = null;
let supervisorUniqueId = `supervisor_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

// --- FUNGSI LOGGING ---
function addLogToSupervisorPanel(message, type = "info") {
    if (!supervisorLogPanel) return;
    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    const logEntry = { timestamp, message, type };
    supervisorLogMessages.unshift(logEntry); 
    if (supervisorLogMessages.length > MAX_LOG_MESSAGES) supervisorLogMessages.pop();
    renderSupervisorLogs();
}
function renderSupervisorLogs() {
    if (!supervisorLogPanel) return;
    supervisorLogPanel.innerHTML = ''; 
    supervisorLogMessages.forEach(log => {
        const logDiv = document.createElement('div');
        logDiv.textContent = `[${log.timestamp}] ${log.message}`;
        if (log.type === "error") logDiv.style.color = "red";
        else if (log.type === "warning") logDiv.style.color = "orange";
        else if (log.type === "success") logDiv.style.color = "green";
        supervisorLogPanel.appendChild(logDiv);
    });
}

// --- FUNGSI KONEKSI WEBSOCKET ---
function connectSupervisorWebSocket() {
    addLogToSupervisorPanel(`Mencoba koneksi ke Node.js server di ${WEBRTC_SUPERVISOR_WS_URL}... (percobaan ${connectionRetryCount + 1})`);
    if (supervisorWebsocket && (supervisorWebsocket.readyState === WebSocket.OPEN || supervisorWebsocket.readyState === WebSocket.CONNECTING)) {
        supervisorWebsocket.onopen = null; supervisorWebsocket.onmessage = null; supervisorWebsocket.onerror = null; supervisorWebsocket.onclose = null;
        supervisorWebsocket.close();
    }
    supervisorWebsocket = new WebSocket(WEBRTC_SUPERVISOR_WS_URL);

    supervisorWebsocket.onopen = () => {
        connectionRetryCount = 0;
        supervisorWebsocket.send(JSON.stringify({ type: 'register_supervisor', supervisor_id: supervisorUniqueId }));
        displaySystemNotification("Terhubung ke server Node.js sebagai supervisor.", "info");
        addLogToSupervisorPanel("Berhasil terhubung ke server WebRTC Node.js.", "success");
        setupHeartbeat();
        // Server akan mengirim update status semua driver setelah registrasi berhasil
    };
    supervisorWebsocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        // addLogToSupervisorPanel(`Menerima pesan dari Node.js server: ${JSON.stringify(data)}`); // Kurangi log jika terlalu banyak
        handleServerMessage(data);
    };
    supervisorWebsocket.onclose = (event) => {
        const logMsg = `Koneksi Node.js server terputus. Kode: ${event.code}. Alasan: ${event.reason || 'Tidak diketahui'}`;
        displaySystemNotification(logMsg, "critical");
        addLogToSupervisorPanel(logMsg, "error");
        if (driverListUI) driverListUI.innerHTML = '<li>Koneksi server terputus. Mencoba menghubungkan kembali...</li>';
        Object.keys(peerConnections).forEach(driverId => resetCallStateSupervisor(driverId));
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        connectionRetryCount++;
        const retryDelay = Math.min(1000 * Math.pow(2, connectionRetryCount), 15000);
        addLogToSupervisorPanel(`Akan mencoba lagi dalam ${retryDelay / 1000} detik...`);
        setTimeout(connectSupervisorWebSocket, retryDelay);
    };
    supervisorWebsocket.onerror = (error) => {
        displaySystemNotification("Error koneksi WebSocket (Node.js).", "critical");
        addLogToSupervisorPanel(`Error koneksi WebSocket ke Node.js: ${error.message || 'Unknown error'}`, "error");
    };
}

function setupHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) {
            supervisorWebsocket.send(JSON.stringify({ type: 'ping' }));
        }
    }, 15000);
}

// --- PENANGANAN PESAN SERVER ---
function handleServerMessage(data) {
    // addLogToSupervisorPanel(`DEBUG: Server message type: ${data.type}`, "info");
    switch (data.type) {
        case 'registration_successful':
            addLogToSupervisorPanel(`Supervisor ${data.supervisor_id} berhasil terdaftar.`, "success");
            // Server akan mengirim `driver_status_update` untuk semua driver setelah ini.
            break;
        case 'pong':
            break;
        case 'driver_list': // Diterima dari server berisi ID driver yang sedang online
            // Fungsi ini bisa digunakan untuk cross-check atau pembaruan cepat daftar driver online
            // Namun, `driver_status_update` akan menjadi sumber utama untuk status individual.
            addLogToSupervisorPanel(`Daftar driver online diterima: ${data.drivers.length > 0 ? data.drivers.join(', ') : 'Kosong'}`, "info");
            // Anda bisa memilih untuk tidak melakukan apa-apa di sini jika updateDriverStatusInList sudah cukup
            // atau melakukan sinkronisasi (misalnya, menghapus driver dari UI jika tidak ada di list ini DAN statusnya offline)
            break;
        case 'driver_status_update':
            updateDriverStatusInList(data.driver_id, data.status.toUpperCase());
            // addLogToSupervisorPanel(`Update status untuk ${data.driver_id}: ${data.status}`, "info"); // Bisa jadi terlalu berisik
            break;
        case 'supervisor_drowsiness_alert':
            displayDrowsinessNotification(data.driver_id, data.message, 'critical');
            updateDriverStatusInList(data.driver_id, 'DROWSY');
            addLogToSupervisorPanel(`PERINGATAN KANTUK ${data.driver_id}: ${data.message}`, "warning");
            break;
        case 'supervisor_driver_normal':
            displayDrowsinessNotification(data.driver_id, `Driver ${data.driver_id} kembali normal.`, 'normal');
            updateDriverStatusInList(data.driver_id, 'ONLINE');
            addLogToSupervisorPanel(`Driver ${data.driver_id} kembali normal.`, "success");
            break;
        case 'webrtc_signal':
            handleWebRTCSignalSupervisor(data);
            break;
        case 'webrtc_signal_failed':
            addLogToSupervisorPanel(`Server gagal kirim sinyal ke '${data.target_id}': ${data.reason}`, "error");
            if (currentCallingDriver === data.target_id) {
                if (callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Panggilan Gagal: ${data.target_id} error.`;
                resetCallStateSupervisor(data.target_id);
            }
            break;
        case 'error':
            displaySystemNotification(`Error server (Node.js): ${data.message}`, 'critical');
            addLogToSupervisorPanel(`Error dari Node.js server: ${data.message}`, "error");
            if (data.message && data.message.toLowerCase().includes("target") && currentCallingDriver) {
                 if (data.message.toLowerCase().includes(currentCallingDriver.toLowerCase())) {
                    resetCallStateSupervisor(currentCallingDriver);
                 }
            }
            break;
        default:
            addLogToSupervisorPanel(`Pesan tidak dikenal dari Node.js server: ${JSON.stringify(data)}`, "warning");
    }
}

// --- MANAJEMEN DAFTAR DRIVER (UI) ---
function updateDriverStatusInList(driverId, status) {
    if (!driverListUI) return;
    let driverLi = document.getElementById(`driver-${driverId}`);

    if (!driverLi) {
        driverLi = document.createElement('li');
        driverLi.id = `driver-${driverId}`;
        // ... (struktur internal <li>: driverInfoContainer, nameSpan, statusBadge, drowsyStatusSpan, actionsDiv, callButton)
        const driverInfoContainer = document.createElement('div'); /* ... */ driverInfoContainer.className = 'driver-info-container';
        const nameSpan = document.createElement('span'); /* ... */ nameSpan.className = 'driver-name'; nameSpan.textContent = driverId;
        const statusBadge = document.createElement('span'); /* ... */ statusBadge.className = 'driver-status-badge';
        const drowsyStatusSpan = document.createElement('span'); /* ... */ drowsyStatusSpan.className = 'driver-alert-status'; drowsyStatusSpan.style.fontWeight = 'bold'; drowsyStatusSpan.style.marginLeft = '5px';
        driverInfoContainer.appendChild(nameSpan); driverInfoContainer.appendChild(statusBadge); driverInfoContainer.appendChild(drowsyStatusSpan);
        driverLi.appendChild(driverInfoContainer);
        const actionsDiv = document.createElement('div'); /* ... */ actionsDiv.className = 'driver-actions';
        const callButton = document.createElement('button'); /* ... */ callButton.textContent = 'Panggil'; callButton.className = 'btn-call'; callButton.onclick = () => startCall(driverId);
        actionsDiv.appendChild(callButton); driverLi.appendChild(actionsDiv);

        const placeholder = driverListUI.querySelector('li');
        if (placeholder && (placeholder.textContent.includes("Memuat daftar driver...") || placeholder.textContent.includes("Koneksi server terputus") || placeholder.textContent.includes("Belum ada driver"))) {
            driverListUI.innerHTML = '';
        }
        driverListUI.appendChild(driverLi);
    }

    const statusBadge = driverLi.querySelector('.driver-status-badge');
    const drowsyStatusSpan = driverLi.querySelector('.driver-alert-status');
    const callButton = driverLi.querySelector('.btn-call');

    driverStatuses.set(driverId, status);

    if (statusBadge) {
        statusBadge.classList.remove('status-drowsy-badge', 'status-online', 'status-offline');
        if (status === 'ONLINE') {
            statusBadge.textContent = 'ONLINE'; statusBadge.classList.add('status-online');
            if (callButton) callButton.disabled = false;
            if (drowsyStatusSpan) drowsyStatusSpan.textContent = '';
        } else if (status === 'OFFLINE') {
            statusBadge.textContent = 'OFFLINE'; statusBadge.classList.add('status-offline');
            if (callButton) callButton.disabled = true;
            if (drowsyStatusSpan) drowsyStatusSpan.textContent = '';
            const existingDrowsinessAlert = document.getElementById(`drowsiness-alert-driver-${driverId}`);
            if (existingDrowsinessAlert && supervisorAlertsListUI) supervisorAlertsListUI.removeChild(existingDrowsinessAlert);
        } else if (status === 'DROWSY') {
            statusBadge.textContent = 'ONLINE'; statusBadge.classList.add('status-online', 'status-drowsy-badge');
            if (callButton) callButton.disabled = false;
            if (drowsyStatusSpan) { drowsyStatusSpan.textContent = `⚠️`; drowsyStatusSpan.style.color = '#e74c3c'; }
        } else {
            statusBadge.textContent = status.toUpperCase();
            if (callButton) callButton.disabled = true;
        }
    }
}

// --- FUNGSI NOTIFIKASI ---
function displaySystemNotification(message, type = 'info') { /* ... (Tidak berubah dari versi sebelumnya) ... */ }
function displayDrowsinessNotification(driverId, message, type) { /* ... (Tidak berubah dari versi sebelumnya) ... */ }

// --- FUNGSI PANGGILAN VIDEO ---
async function startCall(driverId) { /* ... (Tidak berubah signifikan dari versi sebelumnya) ... */ }
function cancelOrEndCall() { /* ... (Tidak berubah signifikan dari versi sebelumnya) ... */ }
function resetCallStateSupervisor(driverId) { /* ... (Tidak berubah signifikan dari versi sebelumnya) ... */ }
function resetUiAfterCallEnd() { /* ... (Tidak berubah dari versi sebelumnya) ... */ }

// --- PENANGANAN SINYAL WEBRTC ---
async function handleWebRTCSignalSupervisor(data) { /* ... (Tidak berubah signifikan dari versi sebelumnya) ... */ }

// --- EVENT LISTENERS DAN INISIALISASI ---
document.addEventListener('DOMContentLoaded', () => {
    addLogToSupervisorPanel("Aplikasi Supervisor dimulai (Node.js version)", "info");
    if(cancelCallBtnSupervisor) {
        cancelCallBtnSupervisor.addEventListener('click', cancelOrEndCall);
        cancelCallBtnSupervisor.style.display = 'none';
    }
    connectSupervisorWebSocket();
    addLogToSupervisorPanel("Event listeners berhasil didaftarkan", "success");
});
window.addEventListener('beforeunload', () => { /* ... (Tidak berubah dari versi sebelumnya) ... */ });
document.addEventListener('visibilitychange', () => { /* ... (Tidak berubah dari versi sebelumnya) ... */ });


// Implementasi fungsi yang disalin jika ada yang terlewat dari versi sebelumnya
// (Pastikan semua fungsi helper yang Anda butuhkan sudah ada di sini)
// Contoh:
function displaySystemNotification(message, type = 'info') {
    if (!supervisorAlertsListUI) return;
    const firstChild = supervisorAlertsListUI.firstChild;
    if (firstChild && firstChild.nodeName === 'P' && firstChild.textContent === "Belum ada notifikasi.") { 
        supervisorAlertsListUI.innerHTML = ''; 
    }
    const alertItem = document.createElement('div'); 
    alertItem.className = `supervisor-alert-item alert-${type}`;
    alertItem.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
    supervisorAlertsListUI.prepend(alertItem);
    if (supervisorAlertsListUI.children.length > 15) { 
        supervisorAlertsListUI.removeChild(supervisorAlertsListUI.lastChild); 
    }
}
function displayDrowsinessNotification(driverId, message, type) {
    if (!supervisorAlertsListUI) return;
    const firstChild = supervisorAlertsListUI.firstChild;
    if (firstChild && firstChild.nodeName === 'P' && firstChild.textContent === "Belum ada notifikasi.") {
        supervisorAlertsListUI.innerHTML = '';
    }
    const existingAlertId = `drowsiness-alert-driver-${driverId}`;
    let alertItem = document.getElementById(existingAlertId);

    if (type === 'normal') { 
        if (alertItem) supervisorAlertsListUI.removeChild(alertItem);
        addLogToSupervisorPanel(`Notifikasi kantuk untuk ${driverId} dibersihkan (kembali normal).`);
        if (supervisorAlertsListUI.children.length === 0) {
             supervisorAlertsListUI.innerHTML = '<p>Belum ada notifikasi.</p>';
        }
        return;
    }
    if (!alertItem) { 
        alertItem = document.createElement('div'); 
        alertItem.id = existingAlertId;
        supervisorAlertsListUI.prepend(alertItem);
    }
    alertItem.className = `supervisor-alert-item alert-${type}`; 
    alertItem.innerHTML = ''; 
    const messageContent = document.createElement('span'); 
    messageContent.className = 'alert-message-content';
    messageContent.textContent = `${new Date().toLocaleTimeString()}: ${message}`; // Pesan sudah termasuk ID driver dari server
    alertItem.appendChild(messageContent);
    if (type === 'critical') {
        const callButton = document.createElement('button'); 
        callButton.textContent = `Panggil ${driverId}`;
        callButton.className = 'btn-call-driver-alert'; 
        callButton.onclick = () => startCall(driverId);
        alertItem.appendChild(callButton);
    }
    if (supervisorAlertsListUI.children.length > 15) { 
        supervisorAlertsListUI.removeChild(supervisorAlertsListUI.lastChild); 
    }
}
async function startCall(driverId) {
    if (!supervisorWebsocket || supervisorWebsocket.readyState !== WebSocket.OPEN) {
        alert("Koneksi Node.js server belum siap. Mencoba menghubungkan kembali...");
        connectSupervisorWebSocket(); return;
    }
    const currentStatus = driverStatuses.get(driverId);
    if (currentStatus === 'OFFLINE' || !currentStatus) {
         alert(`Driver ${driverId} tidak tersedia atau offline.`);
         addLogToSupervisorPanel(`Panggilan ke ${driverId} dibatalkan: driver tidak tersedia/offline`, "warning");
         return;
    }
    if (currentCallingDriver && currentCallingDriver !== driverId) { alert(`Masih dalam panggilan dengan ${currentCallingDriver}.`); return; }
    if (currentCallingDriver === driverId && peerConnections[driverId] && ['connected', 'connecting'].includes(peerConnections[driverId].connectionState)) { alert(`Sudah dalam proses panggilan dengan ${driverId}.`); return;}

    addLogToSupervisorPanel(`Memulai panggilan ke ${driverId}... (Status: ${currentStatus})`, "info");
    if (callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Menghubungi ${driverId}...`;
    if (currentCallingDriverIdUI) currentCallingDriverIdUI.textContent = driverId;
    currentCallingDriver = driverId;
    if (cancelCallBtnSupervisor) { cancelCallBtnSupervisor.style.display = 'inline-block'; cancelCallBtnSupervisor.textContent = "Batalkan Panggilan"; }

    if (peerConnections[driverId]) { peerConnections[driverId].close(); delete peerConnections[driverId]; }

    try {
        if (localStreamSupervisor) localStreamSupervisor.getTracks().forEach(track => track.stop());
        localStreamSupervisor = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (localVideoSupervisor) localVideoSupervisor.srcObject = localStreamSupervisor;
    } catch (error) {
        addLogToSupervisorPanel(`Error akses media: ${error.name} - ${error.message}`, "error");
        if (callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Error: Gagal akses media (${error.name}).`;
        resetUiAfterCallEnd(); return;
    }

    peerConnections[driverId] = new RTCPeerConnection(iceServersSupervisor);
    const pc = peerConnections[driverId];
    if (localStreamSupervisor) localStreamSupervisor.getTracks().forEach(track => pc.addTrack(track, localStreamSupervisor));

    pc.onicecandidate = event => {
        if (event.candidate && supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) {
            supervisorWebsocket.send(JSON.stringify({
                type: 'webrtc_signal', target_id: driverId,
                payload: { type: 'candidate', candidate: event.candidate }
            }));
        }
    };
    pc.ontrack = event => { 
        if(remoteVideoSupervisor && event.streams && event.streams[0]) remoteVideoSupervisor.srcObject = event.streams[0];
    };
    pc.onconnectionstatechange = () => {
        if (!pc) return;
        addLogToSupervisorPanel(`Status koneksi ke ${driverId}: ${pc.connectionState}`);
        if(callStatusSupervisorUI && currentCallingDriver === driverId) callStatusSupervisorUI.textContent = `Status (${driverId}): ${pc.connectionState}`;
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
            if (currentCallingDriver === driverId) resetCallStateSupervisor(driverId);
        }
        if (pc.connectionState === 'connected') { 
            if(cancelCallBtnSupervisor) cancelCallBtnSupervisor.textContent = "Akhiri Panggilan"; 
            if(callTimeoutId) { clearTimeout(callTimeoutId); callTimeoutId = null; }
        } else if (cancelCallBtnSupervisor) { 
            cancelCallBtnSupervisor.textContent = "Batalkan Panggilan"; 
        } 
    };
    if(callTimeoutId) clearTimeout(callTimeoutId);
    callTimeoutId = setTimeout(() => {
        const currentPC = peerConnections[driverId];
        if (currentPC && currentPC.connectionState !== 'connected' && currentPC.connectionState !== 'completed') {
            addLogToSupervisorPanel(`Timeout: Driver ${driverId} tidak merespons. Membatalkan...`, "warning");
            alert(`Driver ${driverId} tidak merespons. Panggilan dibatalkan.`);
            cancelOrEndCall();
        }
        callTimeoutId = null;
    }, 30000);

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        supervisorWebsocket.send(JSON.stringify({
            type: 'webrtc_signal', target_id: driverId,
            payload: { type: 'offer', offer: { sdp: offer.sdp, type: offer.type } }
        }));
        addLogToSupervisorPanel(`Offer WebRTC dikirim ke ${driverId} (via Node.js)`, "info");
    } catch (error) {
        addLogToSupervisorPanel(`Error membuat offer untuk ${driverId}: ${error.message}`, "error");
        resetCallStateSupervisor(driverId);
    }
}
function cancelOrEndCall() {
    if (!currentCallingDriver) return;
    const driverId = currentCallingDriver;
    addLogToSupervisorPanel(`Membatalkan/mengakhiri panggilan dengan ${driverId}`, "info");
    if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) {
        supervisorWebsocket.send(JSON.stringify({
            type: 'webrtc_signal', target_id: driverId,
            payload: { type: 'call_ended', reason: 'Supervisor ended the call.' }
        }));
    }
    resetCallStateSupervisor(driverId);
}
function resetCallStateSupervisor(driverId) {
    if(callTimeoutId) { clearTimeout(callTimeoutId); callTimeoutId = null; }
    if (peerConnections[driverId]) { peerConnections[driverId].close(); delete peerConnections[driverId]; }
    if (currentCallingDriver === driverId || !Object.keys(peerConnections).length) {
      if (localStreamSupervisor) {
        localStreamSupervisor.getTracks().forEach(track => track.stop());
        localStreamSupervisor = null;
      }
    }
    if (currentCallingDriver === driverId) { resetUiAfterCallEnd(); }
    addLogToSupervisorPanel(`Panggilan dengan ${driverId || 'driver'} direset`, "info");
}
function resetUiAfterCallEnd() {
    currentCallingDriver = null;
    if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = "Tidak ada panggilan aktif";
    if(currentCallingDriverIdUI) currentCallingDriverIdUI.textContent = "-";
    if(cancelCallBtnSupervisor) cancelCallBtnSupervisor.style.display = 'none';
    if(localVideoSupervisor) localVideoSupervisor.srcObject = null;
    if(remoteVideoSupervisor) remoteVideoSupervisor.srcObject = null;
}
async function handleWebRTCSignalSupervisor(data) {
    const sourceDriverId = data.sender_id;
    const payload = data.payload;
    if (!sourceDriverId || !payload) { addLogToSupervisorPanel("Sinyal WebRTC dari Node.js tidak valid", "error"); return; }
    addLogToSupervisorPanel(`Menerima sinyal WebRTC dari ${sourceDriverId} (via Node.js): ${payload.type}`, "info");
    if (currentCallingDriver && currentCallingDriver !== sourceDriverId) { addLogToSupervisorPanel(`Mengabaikan sinyal dari ${sourceDriverId}`, "warning"); return; }
    let pc = peerConnections[sourceDriverId];
    if (!pc && !['call_rejected', 'call_busy'].includes(payload.type)) {
        addLogToSupervisorPanel(`Menerima sinyal '${payload.type}' dari ${sourceDriverId} tapi PC tidak ada.`, "error");
        if (currentCallingDriver === sourceDriverId) resetCallStateSupervisor(sourceDriverId);
        return;
    }
    try {
        switch (payload.type) {
            case 'answer':
                if (!pc) return;
                if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') {
                    await pc.setRemoteDescription(new RTCSessionDescription(payload.answer));
                    addLogToSupervisorPanel(`Answer dari ${sourceDriverId} diproses`, "success");
                    if (callTimeoutId) { clearTimeout(callTimeoutId); callTimeoutId = null; }
                } else { addLogToSupervisorPanel(`State salah untuk answer dari ${sourceDriverId}: ${pc.signalingState}`, "warning");}
                break;
            case 'candidate':
                if (!pc) return;
                if (payload.candidate) await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
                break;
            case 'call_rejected':
            case 'call_busy':
                const reason = payload.reason || (payload.type === 'call_busy' ? 'Driver sibuk' : 'Tidak diketahui');
                addLogToSupervisorPanel(`Driver ${sourceDriverId} ${payload.type}: ${reason}`, "warning");
                if (callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Panggilan ${payload.type} oleh ${sourceDriverId}`;
                alert(`Driver ${sourceDriverId} ${payload.type}: ${reason}`);
                resetCallStateSupervisor(sourceDriverId);
                break;
            default: addLogToSupervisorPanel(`Tipe sinyal WebRTC tidak dikenal: ${payload.type}`, "warning");
        }
    } catch (error) {
        addLogToSupervisorPanel(`Error handle sinyal WebRTC dari ${sourceDriverId}: ${error.message}`, "error");
        if (error.name === 'InvalidStateError' || error.name === 'InvalidAccessError') resetCallStateSupervisor(sourceDriverId);
    }
}
window.addEventListener('beforeunload', () => {
    Object.keys(peerConnections).forEach(driverId => { if (peerConnections[driverId]) peerConnections[driverId].close(); });
    if (localStreamSupervisor) localStreamSupervisor.getTracks().forEach(track => track.stop());
    if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) supervisorWebsocket.close();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (callTimeoutId) clearTimeout(callTimeoutId);
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) supervisorWebsocket.send(JSON.stringify({ type: 'ping' }));
            }, 30000); 
        }
    } else {
        setupHeartbeat(); // Ini akan request driver list juga jika diimplementasi di sana
    }
});