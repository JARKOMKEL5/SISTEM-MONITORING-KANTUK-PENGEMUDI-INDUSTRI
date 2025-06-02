// File: Client_Supervisor/Supervisor.js
// Versi yang diperbaiki untuk mengatasi masalah tidak dapat menemukan driver

// =====================================================================================
// KONFIGURASI SERVER
// =====================================================================================
const WEBRTC_SERVER_HOST_SUPERVISOR = location.hostname; 
const WEBRTC_SERVER_PORT_SUPERVISOR = '8080';
const WEBRTC_SUPERVISOR_WS_URL = `ws://${WEBRTC_SERVER_HOST_SUPERVISOR}:${WEBRTC_SERVER_PORT_SUPERVISOR}/ws-webrtc`;
// =====================================================================================

// Variabel global
let supervisorWebsocket;
let peerConnections = {}; 
let localStreamSupervisor;
let currentCallingDriver = null;
let availableDrivers = new Set(); // Track driver yang benar-benar tersedia
let driverStatuses = new Map(); // Track status setiap driver
let connectionRetryCount = 0;
const MAX_RETRY_COUNT = 3;

// Elemen DOM
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
let callTimeoutId = null;
let heartbeatInterval = null;

// =====================================================================================
// FUNGSI LOGGING
// =====================================================================================
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

// =====================================================================================
// FUNGSI KONEKSI WEBSOCKET
// =====================================================================================
function connectSupervisorWebSocket() {
    addLogToSupervisorPanel(`Mencoba koneksi ke server di ${WEBRTC_SUPERVISOR_WS_URL}... (percobaan ${connectionRetryCount + 1})`);
    
    if (supervisorWebsocket) {
        supervisorWebsocket.onopen = null;
        supervisorWebsocket.onmessage = null;
        supervisorWebsocket.onclose = null;
        supervisorWebsocket.onerror = null;
        if (supervisorWebsocket.readyState === WebSocket.OPEN) {
            supervisorWebsocket.close();
        }
    }
    
    supervisorWebsocket = new WebSocket(WEBRTC_SUPERVISOR_WS_URL);

    supervisorWebsocket.onopen = () => {
        connectionRetryCount = 0;
        // Registrasi sebagai supervisor dengan ID unik
        const supervisorId = `supervisor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        supervisorWebsocket.send(JSON.stringify({ 
            type: 'register_supervisor',
            supervisor_id: supervisorId
        }));
        
        displaySystemNotification("Terhubung ke server sebagai supervisor.", "info");
        addLogToSupervisorPanel("Berhasil terhubung ke server WebRTC sebagai supervisor.", "success");
        
        // Request daftar driver yang tersedia
        requestDriverList();
        
        // Setup heartbeat untuk menjaga koneksi
        setupHeartbeat();
    };

    supervisorWebsocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        addLogToSupervisorPanel(`Menerima pesan dari server: ${JSON.stringify(data)}`);
        handleServerMessage(data);
    };

    supervisorWebsocket.onclose = (event) => {
        const logMsg = `Koneksi server terputus. Kode: ${event.code}. Alasan: ${event.reason || 'Tidak diketahui'}`;
        displaySystemNotification(logMsg, "critical"); 
        addLogToSupervisorPanel(logMsg, "error");
        
        // Reset semua state
        availableDrivers.clear();
        driverStatuses.clear();
        if(driverListUI) driverListUI.innerHTML = '<li>Koneksi server terputus. Mencoba menghubungkan kembali...</li>'; 
        Object.keys(peerConnections).forEach(driverId => resetCallStateSupervisor(driverId));
        
        // Clear heartbeat
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        
        // Retry connection dengan backoff
        connectionRetryCount++;
        const retryDelay = Math.min(1000 * Math.pow(2, connectionRetryCount), 10000); // Max 10 detik
        addLogToSupervisorPanel(`Akan mencoba lagi dalam ${retryDelay/1000} detik...`);
        setTimeout(connectSupervisorWebSocket, retryDelay);
    };

    supervisorWebsocket.onerror = (error) => {
        displaySystemNotification("Error koneksi WebSocket.", "critical"); 
        addLogToSupervisorPanel(`Error koneksi WebSocket: ${error.message || 'Unknown error'}`, "error");
    };
}

function setupHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    heartbeatInterval = setInterval(() => {
        if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) {
            supervisorWebsocket.send(JSON.stringify({ type: 'ping' }));
            // Request update driver list setiap 10 detik
            requestDriverList();
        }
    }, 10000); // 10 detik
}

function requestDriverList() {
    if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) {
        supervisorWebsocket.send(JSON.stringify({ type: 'request_driver_list' }));
        addLogToSupervisorPanel("Meminta daftar driver terbaru dari server...");
    }
}

// =====================================================================================
// FUNGSI PENANGANAN PESAN SERVER
// =====================================================================================
function handleServerMessage(data) {
    switch (data.type) {
        case 'pong':
            // Response untuk ping
            break;
            
        case 'driver_list': 
            updateDriverList(data.drivers); 
            addLogToSupervisorPanel(`Daftar driver diterima: ${data.drivers.length > 0 ? data.drivers.join(', ') : 'Kosong'}`, "success"); 
            break;
            
        case 'driver_connected':
            addDriverToAvailableList(data.driver_id);
            addLogToSupervisorPanel(`Driver ${data.driver_id} terhubung`, "success");
            break;
            
        case 'driver_disconnected':
            removeDriverFromAvailableList(data.driver_id);  
            addLogToSupervisorPanel(`Driver ${data.driver_id} terputus`, "warning");
            break;
            
        case 'driver_status_update': 
            updateDriverStatusInList(data.driver_id, data.status.toUpperCase()); 
            addLogToSupervisorPanel(`Status driver ${data.driver_id} diubah menjadi ${data.status}`, "success"); 
            break;
            
        case 'supervisor_drowsiness_alert':
            displayDrowsinessNotification(data.driver_id, data.message, 'critical');
            updateDriverStatusInList(data.driver_id, 'DROWSY', data.message);
            addLogToSupervisorPanel(`PERINGATAN KANTUK ${data.driver_id}: ${data.message}`, "warning");
            break;
            
        case 'supervisor_driver_normal':
            displayDrowsinessNotification(data.driver_id, data.message, 'normal');
            updateDriverStatusInList(data.driver_id, 'ONLINE'); 
            addLogToSupervisorPanel(`Driver ${data.driver_id} kembali normal.`, "success");
            break;
            
        case 'webrtc_signal': 
            handleWebRTCSignalSupervisor(data); 
            break;
            
        case 'call_failed':
            handleCallFailed(data);
            break;
            
        case 'webrtc_signal_failed':
            handleSignalFailed(data);
            break;
            
        case 'error':
            displaySystemNotification(`Error server: ${data.message}`, 'critical');
            addLogToSupervisorPanel(`Error dari server: ${data.message}`, "error");
            
            // Jika error tentang target tidak tersedia, update driver list
            if (data.message && data.message.includes('tidak tersedia atau tidak online')) {
                const match = data.message.match(/Target ID '([^']+)'/);
                if (match) {
                    const driverId = match[1];
                    removeDriverFromAvailableList(driverId);
                    addLogToSupervisorPanel(`Driver ${driverId} ditandai sebagai tidak tersedia`, "warning");
                }
                // Request update driver list
                setTimeout(requestDriverList, 1000);
            }
            break;
            
        default: 
            addLogToSupervisorPanel(`Pesan tidak dikenal dari server: ${JSON.stringify(data)}`, "warning");
    }
}

function handleCallFailed(data) {
    const targetDriver = data.target_driver_id || currentCallingDriver;
    addLogToSupervisorPanel(`Panggilan ke ${targetDriver} gagal: ${data.reason}`, "error");
    
    if (callStatusSupervisorUI) {
        callStatusSupervisorUI.textContent = `Panggilan gagal: ${data.reason}`;
    }
    
    // Jika driver tidak online, update statusnya
    if (data.reason && data.reason.includes('tidak online')) {
        removeDriverFromAvailableList(targetDriver);
    }
    
    resetCallStateSupervisor(targetDriver);
    
    // Request update driver list setelah gagal
    setTimeout(requestDriverList, 1000);
}

function handleSignalFailed(data) {
    const targetId = data.target_id || (data.payload ? data.payload.target : 'unknown');
    addLogToSupervisorPanel(`Server gagal kirim sinyal WebRTC ke '${targetId}' : ${data.reason} (tipe asli: ${data.original_payload_type})`, "error");
    
    // Cek apakah kegagalan ini untuk panggilan yang sedang aktif
    if (currentCallingDriver && (data.target_id === currentCallingDriver || (data.reason && data.reason.includes(currentCallingDriver)))) {
        if (callStatusSupervisorUI) {
            callStatusSupervisorUI.textContent = `Panggilan Gagal: ${currentCallingDriver} tidak online.`;
        }
        alert(`Panggilan ke ${currentCallingDriver} gagal: Target tidak online atau koneksi bermasalah.`);
        resetCallStateSupervisor(currentCallingDriver);
    } 
    
    // Update status driver jika tidak online
    if (data.reason && data.reason.toLowerCase().includes("tidak online")) {
        const failedTargetDriver = data.reason.match(/Target '(.*?)' tidak online/);
        if (failedTargetDriver && failedTargetDriver[1]) {
            removeDriverFromAvailableList(failedTargetDriver[1]);
            updateDriverStatusInList(failedTargetDriver[1], "OFFLINE");
        }
        displaySystemNotification(`Server gagal mengirim sinyal (${data.original_payload_type || ''}): ${data.reason}`, 'critical');
    } else {
        displaySystemNotification(`Server gagal mengirim sinyal (${data.original_payload_type || ''}): ${data.reason || 'Alasan tidak diketahui'}`, 'critical');
    }
    
    // Request update driver list
    setTimeout(requestDriverList, 1000);
}

// =====================================================================================
// FUNGSI MANAJEMEN DRIVER LIST
// =====================================================================================
function addDriverToAvailableList(driverId) {
    availableDrivers.add(driverId);
    driverStatuses.set(driverId, 'ONLINE');
    addDriverToList(driverId, 'ONLINE');
}

function removeDriverFromAvailableList(driverId) {
    availableDrivers.delete(driverId);
    driverStatuses.set(driverId, 'OFFLINE');
    updateDriverStatusInList(driverId, 'OFFLINE');
}

function updateDriverList(drivers) {
    if (!driverListUI) return;
    
    // Update available drivers set
    const newDrivers = new Set(drivers);
    availableDrivers.clear();
    
    // Remove drivers yang sudah tidak ada
    const currentDriverIdsOnUI = new Set(Array.from(driverListUI.children).map(li => li.id.replace('driver-', '')).filter(id => id)); 
    
    currentDriverIdsOnUI.forEach(uiDriverId => {
        if (!newDrivers.has(uiDriverId)) {
            const liToRemove = document.getElementById(`driver-${uiDriverId}`);
            if (liToRemove) driverListUI.removeChild(liToRemove);
            driverStatuses.delete(uiDriverId);
        }
    });
    
    if (drivers.length === 0) {
        if (!driverListUI.querySelector('li') || (driverListUI.firstChild && !driverListUI.firstChild.textContent.includes("Belum ada driver"))){
             driverListUI.innerHTML = '<li>Belum ada driver yang terhubung.</li>';
        }
        availableDrivers.clear();
    } else {
        if (driverListUI.firstChild && (driverListUI.firstChild.textContent.includes("Belum ada driver") || driverListUI.firstChild.textContent.includes("Koneksi server terputus"))){
             driverListUI.innerHTML = '';
        }
        
        // Add semua driver yang tersedia
        drivers.forEach(driverId => {
            availableDrivers.add(driverId);
            driverStatuses.set(driverId, 'ONLINE');
            addDriverToList(driverId, 'ONLINE');
        });
    }
    
    addLogToSupervisorPanel(`Driver tersedia: ${Array.from(availableDrivers).join(', ') || 'Tidak ada'}`, "info");
}

function addDriverToList(driverId, statusText = 'UNKNOWN') {
    if (!driverListUI) return;
    let driverLi = document.getElementById(`driver-${driverId}`);
    
    if (!driverLi) {
        driverLi = document.createElement('li'); 
        driverLi.id = `driver-${driverId}`;
        
        const driverInfoContainer = document.createElement('div'); 
        driverInfoContainer.className = 'driver-info-container';
        
        const nameSpan = document.createElement('span'); 
        nameSpan.className = 'driver-name'; 
        nameSpan.textContent = driverId; 
        driverInfoContainer.appendChild(nameSpan);
        
        const statusBadge = document.createElement('span'); 
        statusBadge.className = 'driver-status-badge'; 
        driverInfoContainer.appendChild(statusBadge);
        
        const drowsyStatusSpan = document.createElement('span'); 
        drowsyStatusSpan.className = 'driver-alert-status'; 
        drowsyStatusSpan.style.fontWeight = 'bold'; 
        drowsyStatusSpan.style.marginLeft = '5px'; 
        driverInfoContainer.appendChild(drowsyStatusSpan);
        
        driverLi.appendChild(driverInfoContainer);
        
        const actionsDiv = document.createElement('div'); 
        actionsDiv.className = 'driver-actions';
        
        const callButton = document.createElement('button'); 
        callButton.textContent = 'Panggil'; 
        callButton.className = 'btn-call'; 
        callButton.onclick = () => startCall(driverId); 
        actionsDiv.appendChild(callButton);
        
        driverLi.appendChild(actionsDiv);
        driverListUI.appendChild(driverLi);
    }
    
    updateDriverStatusInList(driverId, statusText.toUpperCase());
}

function updateDriverStatusInList(driverId, status, alertMessage = "") {
    const driverLi = document.getElementById(`driver-${driverId}`);
    if (!driverLi) { 
        if (status.toUpperCase() !== 'OFFLINE') { 
            addDriverToList(driverId, status); 
        } 
        return; 
    }
    
    const statusBadge = driverLi.querySelector('.driver-status-badge');
    const drowsyStatusSpan = driverLi.querySelector('.driver-alert-status');
    const callButton = driverLi.querySelector('.btn-call');
    
    if (statusBadge) {
        statusBadge.classList.remove('status-drowsy-badge'); 
        
        if (status === 'ONLINE' || status === 'ONLINE_NORMAL') {
            statusBadge.textContent = 'ONLINE'; 
            statusBadge.className = 'driver-status-badge status-online';
            if (callButton) callButton.disabled = false;
            if (drowsyStatusSpan) drowsyStatusSpan.textContent = '';
            driverStatuses.set(driverId, 'ONLINE');
            availableDrivers.add(driverId);
        } else if (status === 'OFFLINE') {
            statusBadge.textContent = 'OFFLINE'; 
            statusBadge.className = 'driver-status-badge status-offline';
            if (callButton) callButton.disabled = true;
            if (drowsyStatusSpan) drowsyStatusSpan.textContent = ''; 
            driverStatuses.set(driverId, 'OFFLINE');
            availableDrivers.delete(driverId);
            
            // Remove existing drowsiness alert
            const existingAlert = document.getElementById(`drowsiness-alert-driver-${driverId}`);
            if(existingAlert && supervisorAlertsListUI) supervisorAlertsListUI.removeChild(existingAlert);
        } else if (status === 'DROWSY') {
            statusBadge.textContent = 'ONLINE'; 
            statusBadge.className = 'driver-status-badge status-online status-drowsy-badge'; 
            if (callButton) callButton.disabled = false;
            if (drowsyStatusSpan) { 
                drowsyStatusSpan.textContent = `⚠️`; 
                drowsyStatusSpan.style.color = '#e74c3c';
            }
            driverStatuses.set(driverId, 'DROWSY');
            availableDrivers.add(driverId);
        } else { 
            statusBadge.textContent = status.toUpperCase(); 
            statusBadge.className = 'driver-status-badge'; 
            if (callButton) callButton.disabled = true; 
            driverStatuses.set(driverId, status);
        }
    }
}

// =====================================================================================
// FUNGSI NOTIFIKASI
// =====================================================================================
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
    messageContent.textContent = `${new Date().toLocaleTimeString()}: Driver ${driverId} - ${message}`;
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

// =====================================================================================
// FUNGSI PANGGILAN VIDEO
// =====================================================================================
async function startCall(driverId) {
    // Validasi koneksi WebSocket
    if (!supervisorWebsocket || supervisorWebsocket.readyState !== WebSocket.OPEN) { 
        alert("Koneksi server belum siap. Mencoba menghubungkan kembali...");
        connectSupervisorWebSocket();
        return; 
    }
    
    // Validasi driver tersedia
    if (!availableDrivers.has(driverId)) {
        alert(`Driver ${driverId} tidak tersedia atau offline. Memperbarui daftar driver...`);
        addLogToSupervisorPanel(`Panggilan ke ${driverId} dibatalkan: driver tidak tersedia`, "warning");
        requestDriverList(); // Request update driver list
        return;
    }
    
    // Validasi panggilan yang sedang berlangsung
    if (currentCallingDriver && currentCallingDriver !== driverId) { 
        alert(`Masih dalam panggilan dengan ${currentCallingDriver}.`); 
        return; 
    }
    
    // Validasi status PeerConnection
    if (currentCallingDriver === driverId && peerConnections[driverId] && 
        ['connected', 'connecting', 'new'].includes(peerConnections[driverId].connectionState)) {
        alert(`Sudah dalam proses panggilan dengan ${driverId}.`); 
        return;
    }
    
    addLogToSupervisorPanel(`Memulai panggilan ke ${driverId}... (Status: ${driverStatuses.get(driverId) || 'Unknown'})`, "info");
    
    if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Menghubungi ${driverId}...`;
    if(currentCallingDriverIdUI) currentCallingDriverIdUI.textContent = driverId;
    currentCallingDriver = driverId;
    
    if(cancelCallBtnSupervisor) {
        cancelCallBtnSupervisor.style.display = 'inline-block'; 
        cancelCallBtnSupervisor.textContent = "Batalkan Panggilan";
    }
    
    // Clean up existing connection
    if (peerConnections[driverId]) { 
        peerConnections[driverId].close(); 
        delete peerConnections[driverId]; 
    } 
    
    try {
        // Setup media stream
        if (localStreamSupervisor) { 
            localStreamSupervisor.getTracks().forEach(track => track.stop()); 
        }
        
        localStreamSupervisor = await navigator.mediaDevices.getUserMedia({ 
            video: true, 
            audio: true 
        });
        
        if(localVideoSupervisor) localVideoSupervisor.srcObject = localStreamSupervisor;
        
        addLogToSupervisorPanel(`Media stream berhasil diperoleh untuk panggilan ke ${driverId}`, "success");
        
    } catch (error) {
        addLogToSupervisorPanel(`Error akses media: ${error.name} - ${error.message}`, "error");
        if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Error: Gagal akses media (${error.name}). Izinkan kamera/mikrofon.`;
        resetUiAfterCallEnd(); 
        return;
    }
    
    // Setup PeerConnection
    peerConnections[driverId] = new RTCPeerConnection(iceServersSupervisor);
    const pc = peerConnections[driverId];
    
    if(localStreamSupervisor) { 
        localStreamSupervisor.getTracks().forEach(track => pc.addTrack(track, localStreamSupervisor)); 
    }
    
    pc.onicecandidate = event => { 
        if (event.candidate && supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) { 
            supervisorWebsocket.send(JSON.stringify({ 
                type: 'webrtc_signal', 
                target_id: driverId, 
                payload: { 
                    type: 'candidate', 
                    candidate: event.candidate 
                }
            })); 
            addLogToSupervisorPanel(`ICE candidate dikirim ke ${driverId}`);
        }
    };
    
    pc.ontrack = event => { 
        if(remoteVideoSupervisor && event.streams && event.streams[0]) {
            remoteVideoSupervisor.srcObject = event.streams[0]; 
            addLogToSupervisorPanel(`Remote video stream diterima dari ${driverId}`, "success");
        } else {
             addLogToSupervisorPanel("Remote video stream dari driver kosong atau tidak valid.", "warning");
        }
    };
    
    pc.onconnectionstatechange = () => {
        if (!pc) return;
        addLogToSupervisorPanel(`Status koneksi ke ${driverId}: ${pc.connectionState}`);
        
        if(callStatusSupervisorUI && currentCallingDriver === driverId) {
            callStatusSupervisorUI.textContent = `Status (${driverId}): ${pc.connectionState}`;
        }
        
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
            if (currentCallingDriver === driverId) { 
                resetCallStateSupervisor(driverId); 
            }
        }
        
        if (pc.connectionState === 'connected') { 
            if(cancelCallBtnSupervisor) cancelCallBtnSupervisor.textContent = "Akhiri Panggilan"; 
            if(callTimeoutId) { 
                clearTimeout(callTimeoutId); 
                callTimeoutId = null; 
            }
            addLogToSupervisorPanel(`Panggilan dengan ${driverId} berhasil terhubung!`, "success");
        } else if (cancelCallBtnSupervisor) { 
            cancelCallBtnSupervisor.textContent = "Batalkan Panggilan"; 
        } 
    };

    // Setup timeout untuk respons
    if(callTimeoutId) clearTimeout(callTimeoutId);
    callTimeoutId = setTimeout(() => {
        const currentPC = peerConnections[driverId];
        if (currentPC && currentPC.connectionState !== 'connected' && currentPC.connectionState !== 'completed') {
            addLogToSupervisorPanel(`Timeout: Driver ${driverId} tidak merespons panggilan dalam 30 detik. Membatalkan...`, "warning");
            alert(`Driver ${driverId} tidak merespons. Panggilan dibatalkan.`);
            cancelOrEndCall();
        }
        callTimeoutId = null;
    }, 30000); // 30 detik timeout
    
    try {
        // Create dan kirim offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        supervisorWebsocket.send(JSON.stringify({
            type: 'webrtc_signal',
            target_id: driverId,
            payload: {
                type: 'offer',
                offer: offer
            }
        }));
        
        addLogToSupervisorPanel(`Offer WebRTC dikirim ke ${driverId}`, "info");
        
    } catch (error) {
        addLogToSupervisorPanel(`Error membuat offer untuk ${driverId}: ${error.message}`, "error");
        if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Error: Gagal membuat offer (${error.name})`;
        resetCallStateSupervisor(driverId);
    }
}

function cancelOrEndCall() {
    if (!currentCallingDriver) return;
    
    const driverId = currentCallingDriver;
    addLogToSupervisorPanel(`Membatalkan/mengakhiri panggilan dengan ${driverId}`, "info");
    
    // Kirim sinyal cancel ke server jika koneksi masih ada
    if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) {
        supervisorWebsocket.send(JSON.stringify({
            type: 'webrtc_signal',
            target_id: driverId,
            payload: { type: 'call_ended' }
        }));
    }
    
    resetCallStateSupervisor(driverId);
}

function resetCallStateSupervisor(driverId) {
    if(callTimeoutId) {
        clearTimeout(callTimeoutId);
        callTimeoutId = null;
    }
    
    // Clean up PeerConnection
    if (peerConnections[driverId]) {
        peerConnections[driverId].close();
        delete peerConnections[driverId];
    }
    
    // Clean up media streams
    if (localStreamSupervisor) {
        localStreamSupervisor.getTracks().forEach(track => track.stop());
        localStreamSupervisor = null;
    }
    
    // Reset UI
    if (currentCallingDriver === driverId || !driverId) {
        resetUiAfterCallEnd();
    }
    
    addLogToSupervisorPanel(`Panggilan dengan ${driverId || 'driver'} telah berakhir`, "info");
}

function resetUiAfterCallEnd() {
    currentCallingDriver = null;
    
    if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = "Tidak ada panggilan aktif";
    if(currentCallingDriverIdUI) currentCallingDriverIdUI.textContent = "-";
    if(cancelCallBtnSupervisor) cancelCallBtnSupervisor.style.display = 'none';
    if(localVideoSupervisor) localVideoSupervisor.srcObject = null;
    if(remoteVideoSupervisor) remoteVideoSupervisor.srcObject = null;
}

// =====================================================================================
// FUNGSI PENANGANAN SINYAL WEBRTC
// =====================================================================================
async function handleWebRTCSignalSupervisor(data) {
    const { source_id, payload } = data;
    
    if (!source_id || !payload) {
        addLogToSupervisorPanel("Sinyal WebRTC tidak valid: missing source_id atau payload", "error");
        return;
    }
    
    addLogToSupervisorPanel(`Menerima sinyal WebRTC dari ${source_id}: ${payload.type}`, "info");
    
    // Jika bukan dari driver yang sedang dipanggil, abaikan
    if (currentCallingDriver && currentCallingDriver !== source_id) {
        addLogToSupervisorPanel(`Mengabaikan sinyal dari ${source_id}, sedang dalam panggilan dengan ${currentCallingDriver}`, "warning");
        return;
    }
    
    let pc = peerConnections[source_id];
    
    try {
        switch (payload.type) {
            case 'answer':
                if (!pc) {
                    addLogToSupervisorPanel(`Menerima answer dari ${source_id} tapi tidak ada PeerConnection`, "error");
                    return;
                }
                
                if (pc.signalingState === 'have-local-offer') {
                    await pc.setRemoteDescription(new RTCSessionDescription(payload.answer));
                    addLogToSupervisorPanel(`Answer dari ${source_id} berhasil diproses`, "success");
                    
                    // Clear timeout karena driver merespons
                    if(callTimeoutId) {
                        clearTimeout(callTimeoutId);
                        callTimeoutId = null;
                    }
                } else {
                    addLogToSupervisorPanel(`Signaling state tidak valid untuk answer dari ${source_id}: ${pc.signalingState}`, "warning");
                }
                break;
                
            case 'candidate':
                if (!pc) {
                    addLogToSupervisorPanel(`Menerima ICE candidate dari ${source_id} tapi tidak ada PeerConnection`, "error");
                    return;
                }
                
                if (payload.candidate) {
                    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
                    addLogToSupervisorPanel(`ICE candidate dari ${source_id} berhasil ditambahkan`);
                } else {
                    addLogToSupervisorPanel(`ICE candidate dari ${source_id} kosong (end-of-candidates)`);
                }
                break;
                
            case 'call_ended':
                addLogToSupervisorPanel(`Driver ${source_id} mengakhiri panggilan`, "info");
                resetCallStateSupervisor(source_id);
                break;
                
            case 'call_rejected':
                addLogToSupervisorPanel(`Driver ${source_id} menolak panggilan`, "warning");
                if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Panggilan ditolak oleh ${source_id}`;
                alert(`Driver ${source_id} menolak panggilan.`);
                resetCallStateSupervisor(source_id);
                break;
                
            case 'driver_busy':
                addLogToSupervisorPanel(`Driver ${source_id} sedang sibuk`, "warning");
                if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Driver ${source_id} sedang sibuk`;
                alert(`Driver ${source_id} sedang dalam panggilan lain.`);
                resetCallStateSupervisor(source_id);
                break;
                
            default:
                addLogToSupervisorPanel(`Tipe sinyal WebRTC tidak dikenal dari ${source_id}: ${payload.type}`, "warning");
        }
    } catch (error) {
        addLogToSupervisorPanel(`Error menangani sinyal WebRTC dari ${source_id}: ${error.message}`, "error");
        
        // Jika error kritis, reset panggilan
        if (error.name === 'InvalidStateError' || error.name === 'InvalidAccessError') {
            addLogToSupervisorPanel(`Error kritis, mereset panggilan dengan ${source_id}`, "error");
            resetCallStateSupervisor(source_id);
        }
    }
}

// =====================================================================================
// EVENT LISTENERS DAN INISIALISASI
// =====================================================================================
document.addEventListener('DOMContentLoaded', () => {
    addLogToSupervisorPanel("Aplikasi Supervisor dimulai", "info");
    
    // Setup cancel call button
    if(cancelCallBtnSupervisor) {
        cancelCallBtnSupervisor.addEventListener('click', cancelOrEndCall);
        cancelCallBtnSupervisor.style.display = 'none';
    }
    
    // Setup refresh driver list button jika ada
    const refreshDriverListBtn = document.getElementById('refreshDriverListBtn');
    if(refreshDriverListBtn) {
        refreshDriverListBtn.addEventListener('click', () => {
            addLogToSupervisorPanel("Meminta refresh daftar driver...", "info");
            requestDriverList();
        });
    }
    
    // Setup clear logs button jika ada
    const clearLogsBtn = document.getElementById('clearLogsBtn');
    if(clearLogsBtn) {
        clearLogsBtn.addEventListener('click', () => {
            supervisorLogMessages = [];
            renderSupervisorLogs();
            addLogToSupervisorPanel("Log dibersihkan", "info");
        });
    }
    
    // Setup clear alerts button jika ada
    const clearAlertsBtn = document.getElementById('clearAlertsBtn');
    if(clearAlertsBtn) {
        clearAlertsBtn.addEventListener('click', () => {
            if(supervisorAlertsListUI) {
                supervisorAlertsListUI.innerHTML = '<p>Belum ada notifikasi.</p>';
            }
            addLogToSupervisorPanel("Notifikasi dibersihkan", "info");
        });
    }
    
    // Mulai koneksi WebSocket
    connectSupervisorWebSocket();
    
    addLogToSupervisorPanel("Event listeners berhasil didaftarkan", "success");
});

// Cleanup saat window ditutup
window.addEventListener('beforeunload', () => {
    // Clean up semua koneksi
    Object.keys(peerConnections).forEach(driverId => {
        if (peerConnections[driverId]) {
            peerConnections[driverId].close();
        }
    });
    
    // Stop media streams
    if (localStreamSupervisor) {
        localStreamSupervisor.getTracks().forEach(track => track.stop());
    }
    
    // Close WebSocket
    if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) {
        supervisorWebsocket.close();
    }
    
    // Clear intervals
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    
    if (callTimeoutId) {
        clearTimeout(callTimeoutId);
    }
});

// Handle visibility change untuk pause/resume heartbeat
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Tab tersembunyi, kurangi frekuensi heartbeat
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => {
                if (supervisorWebsocket && supervisorWebsocket.readyState === WebSocket.OPEN) {
                    supervisorWebsocket.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000); // 30 detik saat tab tersembunyi
        }
    } else {
        // Tab aktif kembali, kembalikan heartbeat normal
        setupHeartbeat();
        // Request update driver list
        requestDriverList();
    }
});

// =====================================================================================
// FUNGSI UTILITAS TAMBAHAN
// =====================================================================================
function getConnectionStatistics(driverId) {
    const pc = peerConnections[driverId];
    if (!pc) return null;
    
    return pc.getStats().then(stats => {
        const statsObj = {};
        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
                statsObj.videoReceived = {
                    bytesReceived: report.bytesReceived,
                    packetsLost: report.packetsLost,
                    framesDecoded: report.framesDecoded
                };
            }
            if (report.type === 'outbound-rtp' && report.mediaType === 'video') {
                statsObj.videoSent = {
                    bytesSent: report.bytesSent,
                    packetsSent: report.packetsSent,
                    framesEncoded: report.framesEncoded
                };
            }
        });
        return statsObj;
    });
}

function logConnectionQuality(driverId) {
    if (!peerConnections[driverId]) return;
    
    getConnectionStatistics(driverId).then(stats => {
        if (stats) {
            addLogToSupervisorPanel(`Statistik koneksi ${driverId}: ${JSON.stringify(stats)}`, "info");
        }
    }).catch(err => {
        addLogToSupervisorPanel(`Error mendapatkan statistik ${driverId}: ${err.message}`, "error");
    });
}

// Export functions untuk testing (jika diperlukan)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        connectSupervisorWebSocket,
        startCall,
        cancelOrEndCall,
        handleWebRTCSignalSupervisor,
        updateDriverList,
        displayDrowsinessNotification,
        displaySystemNotification
    };
}