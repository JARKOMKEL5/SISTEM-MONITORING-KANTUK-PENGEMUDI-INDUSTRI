// File: Client_Supervisor/Supervisor.js

const WEBRTC_SERVER_HOST_SUPERVISOR = location.hostname; 
const WEBRTC_SERVER_PORT_SUPERVISOR = '8080';
const WEBRTC_SUPERVISOR_WS_URL = `ws://${WEBRTC_SERVER_HOST_SUPERVISOR}:${WEBRTC_SERVER_PORT_SUPERVISOR}/ws-webrtc`;

let supervisorWebsocket;
let peerConnections = {}; 
let localStreamSupervisor;
let currentCallingDriver = null;

const driverListUI = document.getElementById('driverList');
const supervisorAlertsListUI = document.getElementById('supervisorAlertsList');
const localVideoSupervisor = document.getElementById('localVideoSupervisor');
const remoteVideoSupervisor = document.getElementById('remoteVideoSupervisor');
const callStatusSupervisorUI = document.getElementById('callStatusSupervisor');
const currentCallingDriverIdUI = document.getElementById('currentCallingDriverId');
const cancelCallBtnSupervisor = document.getElementById('cancelCallBtnSupervisor');
const supervisorLogPanel = document.getElementById('supervisorLogPanel');

const iceServersSupervisor = { iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ]};
let supervisorLogMessages = [];
const MAX_LOG_MESSAGES = 100; 

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
        supervisorLogPanel.appendChild(logDiv);
    });
}

function connectSupervisorWebSocket() {
    addLogToSupervisorPanel(`Mencoba koneksi ke server di ${WEBRTC_SUPERVISOR_WS_URL}...`);
    supervisorWebsocket = new WebSocket(WEBRTC_SUPERVISOR_WS_URL);

    supervisorWebsocket.onopen = () => {
        supervisorWebsocket.send(JSON.stringify({ type: 'register_supervisor' }));
        displaySystemNotification("Terhubung ke server sebagai supervisor.", "info");
        addLogToSupervisorPanel("Berhasil terhubung ke server WebRTC sebagai supervisor.");
    };

    supervisorWebsocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        addLogToSupervisorPanel(`Menerima pesan dari server: ${JSON.stringify(data)}`);
        switch (data.type) {
            case 'driver_list': updateDriverList(data.drivers); addLogToSupervisorPanel(`Daftar driver: ${data.drivers.join(', ') || 'Kosong'}`); break;
            case 'driver_status_update': updateDriverStatusInList(data.driver_id, data.status.toUpperCase()); addLogToSupervisorPanel(`Status ${data.driver_id} -> ${data.status}`); break;
            case 'supervisor_drowsiness_alert':
                displayDrowsinessNotification(data.driver_id, data.message, 'critical');
                updateDriverStatusInList(data.driver_id, 'DROWSY', data.message);
                addLogToSupervisorPanel(`PERINGATAN KANTUK ${data.driver_id}: ${data.message}`, "warning");
                break;
            case 'supervisor_driver_normal':
                displayDrowsinessNotification(data.driver_id, data.message, 'normal');
                updateDriverStatusInList(data.driver_id, 'ONLINE'); 
                addLogToSupervisorPanel(`Driver ${data.driver_id} kembali normal.`);
                break;
            case 'webrtc_signal': handleWebRTCSignalSupervisor(data); break;
            case 'call_failed':
                addLogToSupervisorPanel(`Panggilan ke ${data.target_driver_id || currentCallingDriver} gagal: ${data.reason}`, "error");
                if (callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Panggilan gagal: ${data.reason}`;
                resetCallStateSupervisor(data.target_driver_id || currentCallingDriver);
                break;
            case 'webrtc_signal_failed':
                 addLogToSupervisorPanel(`Server gagal kirim sinyal WebRTC: ${data.reason} (tipe: ${data.original_payload_type})`, "error");
                 if (currentCallingDriver && data.reason && data.reason.includes(currentCallingDriver)) { // Periksa apakah data.reason ada
                     if (callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Panggilan Gagal: ${currentCallingDriver} tidak online.`;
                     alert(`Panggilan ke ${currentCallingDriver} gagal: Target tidak online atau koneksi bermasalah.`);
                     resetCallStateSupervisor(currentCallingDriver);
                 } else { displaySystemNotification(`Server gagal kirim sinyal (${data.original_payload_type || ''}): ${data.reason || 'Alasan tidak diketahui'}`, 'critical');}
                 break;
            case 'error':
                displaySystemNotification(`Error server: ${data.message}`, 'critical');
                addLogToSupervisorPanel(`Error dari server: ${data.message}`, "error");
                break;
            default: 
                addLogToSupervisorPanel(`Pesan tidak dikenal dari server: ${JSON.stringify(data)}`, "warning");
        }
    };
    supervisorWebsocket.onclose = (event) => {
        const logMsg = `Koneksi server terputus. Kode: ${event.code}. Mencoba lagi...`;
        displaySystemNotification(logMsg, "critical"); addLogToSupervisorPanel(logMsg, "error");
        if(driverListUI) driverListUI.innerHTML = '<li>Koneksi server terputus.</li>'; 
        Object.keys(peerConnections).forEach(driverId => resetCallStateSupervisor(driverId));
        setTimeout(connectSupervisorWebSocket, 3000);
    };
    supervisorWebsocket.onerror = (error) => {
        displaySystemNotification("Error koneksi WebSocket.", "critical"); addLogToSupervisorPanel("Error koneksi WebSocket.", "error");
    };
}

function updateDriverList(drivers) {
    if (!driverListUI) return;
    const currentDriverIdsOnUI = new Set(Array.from(driverListUI.children).map(li => li.id.replace('driver-', '')).filter(id => id)); 
    const newDriverIdsFromServer = new Set(drivers);
    currentDriverIdsOnUI.forEach(uiDriverId => {
        if (!newDriverIdsFromServer.has(uiDriverId)) {
            const liToRemove = document.getElementById(`driver-${uiDriverId}`);
            if (liToRemove) driverListUI.removeChild(liToRemove);
        }
    });
    if (drivers.length === 0) {
        if (!driverListUI.querySelector('li') || (driverListUI.firstChild && driverListUI.firstChild.textContent !== "Belum ada driver yang terhubung.")){
             driverListUI.innerHTML = '<li>Belum ada driver yang terhubung.</li>';
        }
    } else if (driverListUI.firstChild && (driverListUI.firstChild.textContent === "Belum ada driver yang terhubung." || driverListUI.firstChild.textContent === "Koneksi server terputus.")){
         driverListUI.innerHTML = '';
    }
    drivers.forEach(driverId => addDriverToList(driverId, 'ONLINE'));
}

function addDriverToList(driverId, statusText = 'UNKNOWN') {
    if (!driverListUI) return;
    let driverLi = document.getElementById(`driver-${driverId}`);
    if (!driverLi) {
        driverLi = document.createElement('li'); driverLi.id = `driver-${driverId}`;
        const driverInfoContainer = document.createElement('div'); driverInfoContainer.className = 'driver-info-container';
        const nameSpan = document.createElement('span'); nameSpan.className = 'driver-name'; nameSpan.textContent = driverId; driverInfoContainer.appendChild(nameSpan);
        const statusBadge = document.createElement('span'); statusBadge.className = 'driver-status-badge'; driverInfoContainer.appendChild(statusBadge);
        const drowsyStatusSpan = document.createElement('span'); drowsyStatusSpan.className = 'driver-alert-status'; drowsyStatusSpan.style.fontWeight = 'bold'; drowsyStatusSpan.style.marginLeft = '5px'; driverInfoContainer.appendChild(drowsyStatusSpan);
        driverLi.appendChild(driverInfoContainer);
        const actionsDiv = document.createElement('div'); actionsDiv.className = 'driver-actions';
        const callButton = document.createElement('button'); callButton.textContent = 'Panggil'; callButton.className = 'btn-call'; callButton.onclick = () => startCall(driverId); actionsDiv.appendChild(callButton);
        driverLi.appendChild(actionsDiv);
        driverListUI.appendChild(driverLi);
    }
    updateDriverStatusInList(driverId, statusText.toUpperCase());
}

function updateDriverStatusInList(driverId, status, alertMessage = "") {
    const driverLi = document.getElementById(`driver-${driverId}`);
    if (!driverLi) { if (status.toUpperCase() !== 'OFFLINE') { addDriverToList(driverId, status); } return; }
    const statusBadge = driverLi.querySelector('.driver-status-badge');
    const drowsyStatusSpan = driverLi.querySelector('.driver-alert-status');
    const callButton = driverLi.querySelector('.btn-call');
    if (statusBadge) {
        statusBadge.classList.remove('status-drowsy-badge'); 
        if (status === 'ONLINE' || status === 'ONLINE_NORMAL') {
            statusBadge.textContent = 'ONLINE'; statusBadge.className = 'driver-status-badge status-online';
            if (callButton) callButton.disabled = false;
            if (drowsyStatusSpan) drowsyStatusSpan.textContent = '';
        } else if (status === 'OFFLINE') {
            statusBadge.textContent = 'OFFLINE'; statusBadge.className = 'driver-status-badge status-offline';
            if (callButton) callButton.disabled = true;
            if (drowsyStatusSpan) drowsyStatusSpan.textContent = ''; 
            const existingAlert = document.getElementById(`drowsiness-alert-driver-${driverId}`);
            if(existingAlert && supervisorAlertsListUI) supervisorAlertsListUI.removeChild(existingAlert);
        } else if (status === 'DROWSY') {
            statusBadge.textContent = 'ONLINE'; statusBadge.className = 'driver-status-badge status-online status-drowsy-badge'; 
            if (callButton) callButton.disabled = false;
            if (drowsyStatusSpan) { drowsyStatusSpan.textContent = `⚠️`; drowsyStatusSpan.style.color = '#e74c3c';}
        } else { statusBadge.textContent = status.toUpperCase(); statusBadge.className = 'driver-status-badge'; if (callButton) callButton.disabled = true; }
    }
}

function displaySystemNotification(message, type = 'info') {
    if (!supervisorAlertsListUI) return;
    if (supervisorAlertsListUI.firstChild && supervisorAlertsListUI.firstChild.nodeName === 'P' && supervisorAlertsListUI.firstChild.textContent === "Belum ada notifikasi.") { supervisorAlertsListUI.innerHTML = ''; }
    const alertItem = document.createElement('div'); alertItem.className = `supervisor-alert-item alert-${type}`;
    alertItem.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
    supervisorAlertsListUI.prepend(alertItem);
    if (supervisorAlertsListUI.children.length > 15) { supervisorAlertsListUI.removeChild(supervisorAlertsListUI.lastChild); }
}

function displayDrowsinessNotification(driverId, message, type) {
    if (!supervisorAlertsListUI) return;
    if (supervisorAlertsListUI.firstChild && supervisorAlertsListUI.firstChild.nodeName === 'P' && supervisorAlertsListUI.firstChild.textContent === "Belum ada notifikasi.") {
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
        alertItem = document.createElement('div'); alertItem.id = existingAlertId;
        supervisorAlertsListUI.prepend(alertItem);
    }
    alertItem.className = `supervisor-alert-item alert-${type}`; 
    alertItem.innerHTML = ''; 
    const messageContent = document.createElement('span'); messageContent.className = 'alert-message-content';
    messageContent.textContent = `${new Date().toLocaleTimeString()}: Driver ${driverId} - ${message}`;
    alertItem.appendChild(messageContent);
    if (type === 'critical') {
        const callButton = document.createElement('button'); callButton.textContent = `Panggil ${driverId}`;
        callButton.className = 'btn-call-driver-alert'; callButton.onclick = () => startCall(driverId);
        alertItem.appendChild(callButton);
    }
    if (supervisorAlertsListUI.children.length > 15) { supervisorAlertsListUI.removeChild(supervisorAlertsListUI.lastChild); }
}

async function startCall(driverId) {
    if (!supervisorWebsocket || supervisorWebsocket.readyState !== WebSocket.OPEN) { alert("Koneksi server belum siap."); return; }
    if (currentCallingDriver && currentCallingDriver !== driverId) { alert(`Masih dalam panggilan dengan ${currentCallingDriver}.`); return; }
    if (currentCallingDriver === driverId && peerConnections[driverId] && ['connected', 'connecting', 'new'].includes(peerConnections[driverId].connectionState)) {
        alert(`Sudah dalam proses panggilan dengan ${driverId}.`); return;
    }
    addLogToSupervisorPanel(`Memulai panggilan ke ${driverId}...`);
    if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Menghubungi ${driverId}...`;
    if(currentCallingDriverIdUI) currentCallingDriverIdUI.textContent = driverId;
    currentCallingDriver = driverId;
    if(cancelCallBtnSupervisor) cancelCallBtnSupervisor.style.display = 'inline-block'; 
    if (peerConnections[driverId]) { peerConnections[driverId].close(); delete peerConnections[driverId]; } 
    try {
        // Selalu coba dapatkan stream baru atau pastikan stream lama masih valid
        if (localStreamSupervisor) { // Hentikan track lama jika ada
            localStreamSupervisor.getTracks().forEach(track => track.stop());
        }
        localStreamSupervisor = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if(localVideoSupervisor) localVideoSupervisor.srcObject = localStreamSupervisor;
        
    } catch (error) {
        addLogToSupervisorPanel(`Error akses media: ${error.message}`, "error");
        if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = 'Error: Gagal akses kamera/mikrofon.';
        resetUiAfterCallEnd(); return;
    }
    peerConnections[driverId] = new RTCPeerConnection(iceServersSupervisor);
    const pc = peerConnections[driverId];
    if(localStreamSupervisor) { localStreamSupervisor.getTracks().forEach(track => pc.addTrack(track, localStreamSupervisor)); }
    pc.onicecandidate = event => { if (event.candidate) { supervisorWebsocket.send(JSON.stringify({ type: 'webrtc_signal', target_id: driverId, payload: { type: 'candidate', candidate: event.candidate }})); }};
    pc.ontrack = event => { if(remoteVideoSupervisor) remoteVideoSupervisor.srcObject = event.streams[0]; };
    pc.onconnectionstatechange = () => {
        if (!pc) return;
        addLogToSupervisorPanel(`Status koneksi ke ${driverId}: ${pc.connectionState}`);
        if(callStatusSupervisorUI && currentCallingDriver === driverId) callStatusSupervisorUI.textContent = `Status (${driverId}): ${pc.connectionState}`;
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
            if (currentCallingDriver === driverId) { resetCallStateSupervisor(driverId); }
        }
        if (pc.connectionState === 'connected' && cancelCallBtnSupervisor) { cancelCallBtnSupervisor.textContent = "Akhiri Panggilan"; }
        else if (cancelCallBtnSupervisor) { cancelCallBtnSupervisor.textContent = "Batalkan Panggilan"; } 
    };
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        supervisorWebsocket.send(JSON.stringify({ type: 'webrtc_signal', target_id: driverId, payload: { type: 'offer', sdp: offer.sdp }}));
        addLogToSupervisorPanel(`Offer dikirim ke ${driverId}.`);
    } catch (error) {
        addLogToSupervisorPanel(`Gagal membuat offer untuk ${driverId}: ${error.message}`, "error");
        if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Gagal offer untuk ${driverId}.`;
        resetCallStateSupervisor(driverId);
    }
}

async function handleWebRTCSignalSupervisor(data) {
    const fromId = data.from_id; const payload = data.payload;
    const pc = peerConnections[fromId];
    if (!pc) { addLogToSupervisorPanel(`Menerima sinyal untuk ${fromId} tapi PC tidak ada.`, "warning"); return; }
    addLogToSupervisorPanel(`Menerima sinyal tipe '${payload.type}' dari ${fromId}`);
    try {
        if (payload.type === 'answer') { await pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: payload.sdp})); }
        else if (payload.type === 'candidate') { 
            if (payload.candidate) { // Pastikan kandidat tidak null
                 await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); 
            } else {
                addLogToSupervisorPanel(`Menerima kandidat null dari ${fromId}. Mungkin akhir dari kandidat.`, "info");
            }
        }
        else if (payload.type === 'call_rejected' || payload.type === 'call_busy') {
            alert(`Driver ${fromId} menolak/sibuk: ${payload.reason}`);
            addLogToSupervisorPanel(`Panggilan ke ${fromId} ditolak/sibuk: ${payload.reason}`, "warning");
            resetCallStateSupervisor(fromId);
        } else if (payload.type === 'call_cancelled_by_supervisor') { 
             console.warn("Supervisor salah menerima 'call_cancelled_by_supervisor'. Ini seharusnya untuk driver.");
        }
    } catch (error) { addLogToSupervisorPanel(`Error proses sinyal dari ${fromId}: ${error.message}`, "error");}
}

function resetUiAfterCallEnd() { 
    if(remoteVideoSupervisor) remoteVideoSupervisor.srcObject = null;
    // Hentikan stream lokal supervisor SETELAH panggilan benar-benar selesai/dibatalkan
    if(localStreamSupervisor && localVideoSupervisor) {
        localStreamSupervisor.getTracks().forEach(track => track.stop());
        localVideoSupervisor.srcObject = null;
        localStreamSupervisor = null; // Set null agar getUserMedia dipanggil lagi untuk call berikutnya
    }
    if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = 'Status Panggilan: Tidak Aktif';
    if(currentCallingDriverIdUI) currentCallingDriverIdUI.textContent = '-';
    if(cancelCallBtnSupervisor) {
        cancelCallBtnSupervisor.style.display = 'none';
        cancelCallBtnSupervisor.textContent = 'Batalkan Panggilan'; 
    }
    currentCallingDriver = null;
}

function resetCallStateSupervisor(driverId) {
    addLogToSupervisorPanel(`Mereset status panggilan untuk ${driverId || 'driver tidak dikenal'}`);
    const pcToClose = peerConnections[driverId];
    if (pcToClose) {
        pcToClose.onicecandidate = null; pcToClose.ontrack = null;
        pcToClose.onconnectionstatechange = null; 
        if (pcToClose.signalingState !== "closed") pcToClose.close();
        delete peerConnections[driverId];
    }
    if (currentCallingDriver === driverId) { 
        resetUiAfterCallEnd();
    }
}

function cancelOrEndCall() {
    if (!currentCallingDriver) {
        // Tombol seharusnya tidak terlihat jika tidak ada currentCallingDriver, tapi sebagai jaga-jaga
        if(cancelCallBtnSupervisor) cancelCallBtnSupervisor.style.display = 'none';
        return;
    }
    addLogToSupervisorPanel(`Membatalkan/Mengakhiri panggilan dengan ${currentCallingDriver}`);
    const pc = peerConnections[currentCallingDriver];

    if (pc && (pc.connectionState === 'new' || pc.connectionState === 'connecting' || pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-remote-offer')) {
        if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) {
            supervisorWebsocket.send(JSON.stringify({
                type: 'cancel_call_attempt', 
                target_driver_id: currentCallingDriver
            }));
            addLogToSupervisorPanel(`Permintaan pembatalan panggilan ke ${currentCallingDriver} dikirim.`);
        }
    }
    resetCallStateSupervisor(currentCallingDriver); 
}

document.addEventListener('DOMContentLoaded', () => {
    connectSupervisorWebSocket();
    if (cancelCallBtnSupervisor) {
        cancelCallBtnSupervisor.onclick = cancelOrEndCall;
    } else {
        console.error("Tombol 'cancelCallBtnSupervisor' tidak ditemukan saat DOMContentLoaded!");
    }
    addLogToSupervisorPanel("Halaman supervisor dimuat dan siap.");
    renderSupervisorLogs(); 
});