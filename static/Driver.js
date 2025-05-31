document.addEventListener('DOMContentLoaded', (event) => {
    const socket = io.connect(location.protocol + '//' + document.domain + ':' + location.port);

    const systemStatusEl = document.getElementById('systemStatus');
    const calibrationStatusEl = document.getElementById('calibrationStatus');
    const earValueEl = document.getElementById('earValue');
    const perclosValueEl = document.getElementById('perclosValue');
    const thresholdValueEl = document.getElementById('thresholdValue');
    const alertMessageEl = document.getElementById('alertMessage');

    function formatValue(value, precision = 3, defaultValue = '-') {
        return (value !== null && value !== undefined && value !== -1) ? Number(value).toFixed(precision) : defaultValue;
    }
    
    function setAlertMessage(message, type) {
        alertMessageEl.textContent = message;
        alertMessageEl.className = ''; // Reset classes
        if (type === 'alert') {
            alertMessageEl.classList.add('alert-critical');
        } else if (type === 'warning') {
            alertMessageEl.classList.add('alert-warning');
        } else if (type === 'normal' || type === 'info' || type === 'calibration_done') {
            alertMessageEl.classList.add('alert-normal');
        } else {
             alertMessageEl.classList.add('alert-normal'); // Default
        }
    }

    socket.on('connect', function() {
        console.log('Terhubung ke server WebSocket!');
        systemStatusEl.textContent = 'Terhubung. Menunggu kamera...';
        systemStatusEl.className = 'status-calibrating';
    });

    socket.on('disconnect', function() {
        console.log('Koneksi WebSocket terputus.');
        systemStatusEl.textContent = 'Koneksi Terputus';
        systemStatusEl.className = 'status-error';
        setAlertMessage('Koneksi ke server terputus!', 'error');
    });
    
    socket.on('status_update', function(data) {
        console.log('Status Update:', data);
        if (data.message) {
            if (data.type === 'error') {
                systemStatusEl.textContent = data.message;
                systemStatusEl.className = 'status-error';
                setAlertMessage(data.message, 'error');
            } else if (data.type === 'calibration_info') {
                systemStatusEl.textContent = 'Kalibrasi...';
                systemStatusEl.className = 'status-calibrating';
                calibrationStatusEl.textContent = 'Sedang Berlangsung';
            } else if (data.type === 'calibration_done') {
                systemStatusEl.textContent = 'Terkalibrasi & Memantau';
                systemStatusEl.className = 'status-monitoring';
                calibrationStatusEl.textContent = 'Selesai';
                setAlertMessage(data.message, 'normal');
            } else if (data.type === 'no_face') {
                systemStatusEl.textContent = data.message;
                systemStatusEl.className = 'status-no-face';
                earValueEl.textContent = '-';
                perclosValueEl.textContent = '-';
            } else {
                systemStatusEl.textContent = data.message; 
            }
        }
        if (data.is_calibrated !== undefined) {
            calibrationStatusEl.textContent = data.is_calibrated ? 'Selesai' : 'Belum / Sedang';
        }
        if (data.dynamic_threshold !== undefined) {
            thresholdValueEl.textContent = formatValue(data.dynamic_threshold, 3);
        }
    });

    socket.on('update_data', function(data) {
        earValueEl.textContent = formatValue(data.ear, 3);
        perclosValueEl.textContent = formatValue(data.perclos, 2);
        calibrationStatusEl.textContent = data.is_calibrated ? 'Selesai' : 'Belum / Sedang';
        thresholdValueEl.textContent = formatValue(data.dynamic_threshold, 3);

        if (!data.is_calibrated) {
            systemStatusEl.textContent = 'Kalibrasi...';
            systemStatusEl.className = 'status-calibrating';
        } else {
            if (systemStatusEl.textContent !== 'KANTUK TERDETEKSI!') {
                systemStatusEl.textContent = 'Memantau...';
                systemStatusEl.className = 'status-monitoring';
            }
        }
    });

    socket.on('drowsiness_alert', function(data) {
        console.log('Drowsiness Alert:', data);
        setAlertMessage(data.message, data.type);

        if (data.type === 'alert') {
            systemStatusEl.textContent = 'KANTUK TERDETEKSI!';
            systemStatusEl.className = 'status-error';
        } else if (data.type === 'normal') {
            if (data.is_calibrated) {
                systemStatusEl.textContent = 'Memantau...';
                systemStatusEl.className = 'status-monitoring';
            } else {
                systemStatusEl.textContent = 'Kalibrasi...';
                systemStatusEl.className = 'status-calibrating';
            }
        }
    });
});
