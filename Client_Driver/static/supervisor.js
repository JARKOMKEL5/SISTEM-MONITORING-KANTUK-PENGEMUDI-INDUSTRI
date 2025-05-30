// Connect ke server Flask-SocketIO
const socket = io("http://127.0.0.1:5500");

// Saat koneksi berhasil
socket.on("connect", () => {
  console.log("Terhubung ke server");
});

// Terima pesan dari driver
socket.on("driver_message", (data) => {
  const msgBox = document.getElementById("messages");
  const content = data.data || "";

  // Jika pesan mengandung kata penting, tampilkan alert
  if (
    content.toLowerCase().includes("ngantuk") ||
    content.toLowerCase().includes("tidak pakai sabuk")
  ) {
    msgBox.innerHTML += `<p class="alert">🚨 ALERT dari Driver: ${content}</p>`;
  } else {
    msgBox.innerHTML += `<p><strong>Driver:</strong> ${content}</p>`;
  }

  msgBox.scrollTop = msgBox.scrollHeight;
});

// Kirim pesan ke driver
function sendToDriver() {
  const inputBox = document.getElementById("supervisorInput");
  const message = inputBox.value.trim();

  if (message !== "") {
    socket.emit("supervisor_message", { data: message });

    const msgBox = document.getElementById("messages");
    msgBox.innerHTML += `<p><strong>Anda:</strong> ${message}</p>`;
    msgBox.scrollTop = msgBox.scrollHeight;

    inputBox.value = ""; // reset input
  }
}

// Pasang event listener ke tombol
document.getElementById("sendBtn").addEventListener("click", sendToDriver);
