// File: Client_Supervisor/Supervisor.js

// =====================================================================================
// KONFIGURASI SERVER
// =====================================================================================
// location.hostname akan mengambil IP atau hostname dari URL browser saat ini.
const WEBRTC_SERVER_HOST_SUPERVISOR = location.hostname; 
const WEBRTC_SERVER_PORT_SUPERVISOR = '8080'; // Port Server_Backend/Server.py (aiohttp)
const WEBRTC_SUPERVISOR_WS_URL = `ws://${WEBRTC_SERVER_HOST_SUPERVISOR}:${WEBRTC_SERVER_PORT_SUPERVISOR}/ws-webrtc`;
// =====================================================================================


let supervisorWebsocket;
let peerConnections = {}; // { driverId: RTCPeerConnection }
let localStreamSupervisor;
let currentCallingDriver = null; // Menyimpan ID driver yang sedang dalam panggilan

// --- Elemen DOM ---
const driverListUI = document.getElementById('driverList');
const supervisorAlertsListUI = document.getElementById('supervisorAlertsList');
const localVideoSupervisor = document.getElementById('localVideoSupervisor');
const remoteVideoSupervisor = document.getElementById('remoteVideoSupervisor');
const callStatusSupervisorUI = document.getElementById('callStatusSupervisor');
const currentCallingDriverIdUI = document.getElementById('currentCallingDriverId');

const iceServersSupervisor = {
    iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ]
};

function connectSupervisorWebSocket() {
    console.log(`Mencoba koneksi Supervisor WS ke: ${WEBRTC_SUPERVISOR_WS_URL}`);
    supervisorWebsocket = new WebSocket(WEBRTC_SUPERVISOR_WS_URL);

    supervisorWebsocket.onopen = () => {
        console.log("Supervisor: Terhubung ke Server WebRTC.");
        supervisorWebsocket.send(JSON.stringify({ type: 'register_supervisor' }));
        displaySystemNotification("Terhubung ke server sebagai supervisor.", "info");
    };

    supervisorWebsocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("Supervisor Menerima (WebRTC):", data);

        switch (data.type) {
            case 'driver_list':
                updateDriverList(data.drivers);
                break;
            case 'driver_status_update': // Driver online atau offline
                updateDriverStatusInList(data.driver_id, data.status);
                break;
            case 'supervisor_drowsiness_alert': // Notifikasi kantuk dari server
                displayDrowsinessNotification(data.driver_id, data.message, 'critical');
                updateDriverStatusInList(data.driver_id, 'DROWSY', data.message);
                break;
            case 'supervisor_driver_normal': // Notifikasi driver kembali normal
                displayDrowsinessNotification(data.driver_id, data.message, 'normal');
                updateDriverStatusInList(data.driver_id, 'ONLINE'); // Kembali ke status online normal
                break;
            case 'webrtc_signal': // Menerima sinyal WebRTC dari driver (answer atau candidate)
                handleWebRTCSignalSupervisor(data);
                break;
            case 'call_failed': // Jika permintaan panggilan gagal di server
                alert(`Panggilan ke ${data.target_driver_id || currentCallingDriver} gagal: ${data.reason}`);
                if (callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Panggilan gagal: ${data.reason}`;
                resetCallStateSupervisor(currentCallingDriver); // Reset state untuk driver tersebut
                break;
            case 'error': // Pesan error umum dari server
                console.error("Error dari server:", data.message);
                displaySystemNotification(`Error server: ${data.message}`, 'critical');
                break;
            default:
                console.warn("Supervisor menerima pesan WebRTC tipe tidak dikenal:", data);
        }
    };

    supervisorWebsocket.onclose = (event) => {
        console.log('Koneksi Supervisor WS terputus. Kode:', event.code, 'Alasan:', event.reason);
        displaySystemNotification("Koneksi ke server terputus. Mencoba menghubungkan kembali...", "critical");
        // Hapus semua driver dari daftar karena statusnya tidak diketahui
        if(driverListUI) driverListUI.innerHTML = '<li>Koneksi server terputus.</li>'; 
        // Coba sambungkan lagi setelah beberapa detik
        setTimeout(connectSupervisorWebSocket, 3000);
    };

    supervisorWebsocket.onerror = (error) => {
        console.error('Supervisor WebSocket Error:', error);
        displaySystemNotification("Error koneksi WebSocket.", "critical");
        // onclose biasanya akan terpanggil setelah ini
    };
}

function updateDriverList(drivers) {
    if (!driverListUI) return;
    driverListUI.innerHTML = ''; // Bersihkan daftar
    if (drivers.length === 0) {
        driverListUI.innerHTML = '<li>Belum ada driver yang terhubung.</li>';
        return;
    }
    drivers.forEach(driverId => addDriverToList(driverId, 'ONLINE'));
}

function addDriverToList(driverId, statusText = 'UNKNOWN') {
    if (!driverListUI) return;
    let driverLi = document.getElementById(`driver-${driverId}`);
    if (!driverLi) {
        driverLi = document.createElement('li');
        driverLi.id = `driver-${driverId}`;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'driver-name';
        nameSpan.textContent = driverId;
        driverLi.appendChild(nameSpan);

        const statusBadge = document.createElement('span');
        statusBadge.className = 'driver-status-badge';
        driverLi.appendChild(statusBadge);
        
        // Span untuk status kantuk khusus, dipisahkan dari status online/offline
        const drowsyStatusSpan = document.createElement('span');
        drowsyStatusSpan.className = 'driver-alert-status'; // Class yang sama dengan di Driver.js
        drowsyStatusSpan.style.marginLeft = '10px';
        drowsyStatusSpan.style.fontWeight = 'bold';
        driverLi.appendChild(drowsyStatusSpan);


        const callButton = document.createElement('button');
        callButton.textContent = 'Panggil';
        callButton.className = 'btn-call';
        callButton.onclick = () => startCall(driverId);
        driverLi.appendChild(callButton);

        driverListUI.appendChild(driverLi);
    }
    // Update status online/offline pada badge
    const statusBadge = driverLi.querySelector('.driver-status-badge');
    const callButton = driverLi.querySelector('.btn-call');

    if (statusText.toUpperCase() === 'ONLINE' || statusText.toUpperCase() === 'DROWSY' || statusText.toUpperCase() === 'ONLINE_NORMAL') {
        statusBadge.textContent = 'ONLINE';
        statusBadge.className = 'driver-status-badge status-online';
        if(callButton) callButton.disabled = false;
    } else if (statusText.toUpperCase() === 'OFFLINE') {
        statusBadge.textContent = 'OFFLINE';
        statusBadge.className = 'driver-status-badge status-offline';
        if(callButton) callButton.disabled = true;
        // Hapus status kantuk jika driver offline
        const drowsyStatusSpan = driverLi.querySelector('.driver-alert-status');
        if(drowsyStatusSpan) drowsyStatusSpan.textContent = '';
    } else {
        statusBadge.textContent = statusText.toUpperCase();
        statusBadge.className = 'driver-status-badge'; // Default
        if(callButton) callButton.disabled = true; // Nonaktifkan jika status tidak diketahui
    }
}

function updateDriverStatusInList(driverId, status, alertMessage = "") {
    addDriverToList(driverId, status); // Ini akan membuat atau update status online/offline
    
    const driverLi = document.getElementById(`driver-${driverId}`);
    if (driverLi) {
        const drowsyStatusSpan = driverLi.querySelector('.driver-alert-status');
        const statusBadge = driverLi.querySelector('.driver-status-badge');

        if (drowsyStatusSpan) {
            if (status === 'DROWSY') {
                drowsyStatusSpan.textContent = `⚠️ Mengantuk!`;
                drowsyStatusSpan.style.color = '#e74c3c';
                if (statusBadge) statusBadge.classList.add('status-drowsy'); // Tambahkan efek blink
            } else if (status === 'ONLINE_NORMAL' || status === 'ONLINE') {
                drowsyStatusSpan.textContent = ''; // Hapus pesan kantuk jika kembali normal
                drowsyStatusSpan.style.color = 'green'; // Atau sembunyikan
                 if (statusBadge) statusBadge.classList.remove('status-drowsy');
                // Optional: Hapus pesan "Normal" setelah beberapa detik
                // setTimeout(() => {
                //     if (drowsyStatusSpan.textContent.includes('Normal')) drowsyStatusSpan.textContent = '';
                // }, 5000);
            }
        }
    }
}


function displaySystemNotification(message, type = 'info') {
    if (!supervisorAlertsListUI) { console.error("Elemen 'supervisorAlertsListUI' tidak ada."); return; }
    if (supervisorAlertsListUI.firstChild && supervisorAlertsListUI.firstChild.textContent === "Belum ada notifikasi.") {
        supervisorAlertsListUI.innerHTML = ''; // Hapus pesan default
    }
    const alertItem = document.createElement('div');
    alertItem.className = `supervisor-alert-item alert-${type}`;
    alertItem.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
    supervisorAlertsListUI.prepend(alertItem);
    if (supervisorAlertsListUI.children.length > 15) { supervisorAlertsListUI.removeChild(supervisorAlertsListUI.lastChild); }
}

function displayDrowsinessNotification(driverId, message, type) {
    if (!supervisorAlertsListUI) { console.error("Elemen 'supervisorAlertsListUI' tidak ada."); return; }
     if (supervisorAlertsListUI.firstChild && supervisorAlertsListUI.firstChild.nodeType === Node.ELEMENT_NODE && supervisorAlertsListUI.firstChild.textContent === "Belum ada notifikasi.") {
        supervisorAlertsListUI.innerHTML = ''; // Hapus pesan default jika itu satu-satunya elemen
    } else if (supervisorAlertsListUI.firstChild && supervisorAlertsListUI.firstChild.nodeType === Node.TEXT_NODE && supervisorAlertsListUI.firstChild.textContent.trim() === "Belum ada notifikasi."){
         supervisorAlertsListUI.innerHTML = '';
    }


    const alertItem = document.createElement('div');
    alertItem.id = `alert-driver-${driverId}`;
    alertItem.className = `supervisor-alert-item alert-${type}`;

    const messageContent = document.createElement('span');
    messageContent.className = 'alert-message-content';
    messageContent.textContent = `${new Date().toLocaleTimeString()}: Driver ${driverId} - ${message}`;
    alertItem.appendChild(messageContent);

    if (type === 'critical') { // Hanya tambahkan tombol panggil untuk alert kantuk kritis
        const callButton = document.createElement('button');
        callButton.textContent = `Panggil ${driverId}`;
        callButton.className = 'btn-call-driver-alert';
        callButton.style.marginLeft = '10px';
        callButton.onclick = () => startCall(driverId);
        alertItem.appendChild(callButton);
    }
    
    // Cek apakah sudah ada alert untuk driver ini, jika ya, ganti
    const existingAlert = document.getElementById(alertItem.id);
    if (existingAlert) {
        supervisorAlertsListUI.replaceChild(alertItem, existingAlert);
    } else {
        supervisorAlertsListUI.prepend(alertItem);
    }

    if (type === 'normal') { // Hapus notifikasi normal setelah beberapa detik
        setTimeout(() => {
            if (alertItem.parentNode === supervisorAlertsListUI && alertItem.className.includes('alert-normal')) {
                supervisorAlertsListUI.removeChild(alertItem);
                if (supervisorAlertsListUI.children.length === 0) {
                     supervisorAlertsListUI.innerHTML = '<p>Belum ada notifikasi.</p>';
                }
            }
        }, 10000); // Hapus setelah 10 detik
    }
    if (supervisorAlertsListUI.children.length > 15) { supervisorAlertsListUI.removeChild(supervisorAlertsListUI.lastChild); }
}


async function startCall(driverId) {
    if (!supervisorWebsocket || supervisorWebsocket.readyState !== WebSocket.OPEN) {
        alert("Koneksi ke server WebSocket belum siap. Silakan coba lagi.");
        return;
    }
    if (currentCallingDriver && currentCallingDriver !== driverId) {
        alert(`Masih dalam panggilan dengan ${currentCallingDriver}. Harap selesaikan panggilan tersebut terlebih dahulu.`);
        return;
    }
    if (currentCallingDriver === driverId && peerConnections[driverId] && (peerConnections[driverId].connectionState === 'connected' || peerConnections[driverId].connectionState === 'connecting')) {
        alert(`Anda sudah dalam proses panggilan dengan ${driverId}.`);
        return;
    }

    console.log(`Supervisor: Memulai panggilan ke ${driverId}...`);
    if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Menghubungi ${driverId}...`;
    if(currentCallingDriverIdUI) currentCallingDriverIdUI.textContent = driverId;
    currentCallingDriver = driverId;

    // Tutup PeerConnection lama jika ada untuk driver ini
    if (peerConnections[driverId]) {
        peerConnections[driverId].close();
    }

    try {
        if (!localStreamSupervisor || localStreamSupervisor.getTracks().every(track => track.readyState === 'ended')) {
            localStreamSupervisor = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            if(localVideoSupervisor) localVideoSupervisor.srcObject = localStreamSupervisor;
        }
    } catch (error) {
        console.error('Supervisor: Error mendapatkan media lokal:', error);
        if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = 'Error: Gagal akses kamera/mikrofon.';
        currentCallingDriver = null; if(currentCallingDriverIdUI) currentCallingDriverIdUI.textContent = '-';
        return;
    }

    peerConnections[driverId] = new RTCPeerConnection(iceServersSupervisor);
    const pc = peerConnections[driverId];

    if(localStreamSupervisor) {
        localStreamSupervisor.getTracks().forEach(track => pc.addTrack(track, localStreamSupervisor));
    }

    pc.onicecandidate = event => {
        if (event.candidate) {
            supervisorWebsocket.send(JSON.stringify({
                type: 'webrtc_signal',
                target_id: driverId,
                payload: { type: 'candidate', candidate: event.candidate }
            }));
        }
    };
    pc.ontrack = event => {
        console.log("Supervisor: Menerima remote track dari Driver");
        if(remoteVideoSupervisor) remoteVideoSupervisor.srcObject = event.streams[0];
    };
    pc.onconnectionstatechange = () => {
        if (!pc) return;
        console.log(`Status koneksi Peer Supervisor ke ${driverId}: ${pc.connectionState}`);
        if(callStatusSupervisorUI && currentCallingDriver === driverId) callStatusSupervisorUI.textContent = `Status Panggilan (${driverId}): ${pc.connectionState}`;
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
            if (currentCallingDriver === driverId) { // Hanya reset jika ini panggilan yang aktif
                 resetCallStateSupervisor(driverId);
            }
        }
    };

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        supervisorWebsocket.send(JSON.stringify({
            type: 'webrtc_signal',
            target_id: driverId,
            payload: { type: 'offer', sdp: offer.sdp }
        }));
    } catch (error) {
        console.error('Supervisor: Gagal membuat offer:', error);
        if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = `Gagal membuat offer untuk ${driverId}.`;
        resetCallStateSupervisor(driverId);
    }
}

async function handleWebRTCSignalSupervisor(data) {
    const fromId = data.from_id; // Ini adalah driver_id
    const payload = data.payload;
    const pc = peerConnections[fromId];

    if (!pc) {
        console.warn(`Supervisor: Menerima sinyal untuk driver ${fromId} tapi tidak ada PeerConnection.`);
        return;
    }
    console.log(`Supervisor: Menerima sinyal tipe '${payload.type}' dari Driver ${fromId}`);

    try {
        if (payload.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: payload.sdp}));
        } else if (payload.type === 'candidate') {
            await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } else if (payload.type === 'call_rejected' || payload.type === 'call_busy') {
            alert(`Driver ${fromId} menolak/sibuk: ${payload.reason}`);
            resetCallStateSupervisor(fromId);
        }
    } catch (error) {
        console.error(`Supervisor: Error memproses sinyal dari ${fromId}:`, error);
    }
}

function resetCallStateSupervisor(driverId) {
    console.log(`Supervisor: Mereset status panggilan untuk ${driverId}`);
    if (peerConnections[driverId]) {
        peerConnections[driverId].onicecandidate = null;
        peerConnections[driverId].ontrack = null;
        peerConnections[driverId].onconnectionstatechange = null;
        peerConnections[driverId].close();
        delete peerConnections[driverId];
    }
    // Hanya reset UI jika driver yang direset adalah driver yang sedang aktif dipanggil
    if (currentCallingDriver === driverId) {
        if(localVideoSupervisor && localVideoSupervisor.srcObject === localStreamSupervisor) {
            // Jangan hentikan localStreamSupervisor jika ingin bisa langsung call driver lain
            // localStreamSupervisor.getTracks().forEach(track => track.stop());
            // localVideoSupervisor.srcObject = null;
        }
        if(remoteVideoSupervisor) remoteVideoSupervisor.srcObject = null;
        if(callStatusSupervisorUI) callStatusSupervisorUI.textContent = 'Status Panggilan: Tidak Aktif';
        if(currentCallingDriverIdUI) currentCallingDriverIdUI.textContent = '-';
        currentCallingDriver = null;
    }
}

// Inisialisasi koneksi Supervisor WebSocket saat halaman dimuat
document.addEventListener('DOMContentLoaded', () => {
    connectSupervisorWebSocket();
});