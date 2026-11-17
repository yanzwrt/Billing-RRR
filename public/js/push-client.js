// =========================================================================
// [MODUL KLIEN: REGISTRASI PUSH NOTIFIKASI DI BROWSER HP]
// Lokasi File: public/js/push-client.js
// Fungsi:
// 1. Meminta izin browser (Notification.requestPermission)
// 2. Mengambil token perangkat dari Google FCM/Apple APNs
// 3. Mengirimkan token ke backend server secara otomatis
// =========================================================================

// Helper mengubah Public Key VAPID base64 ke Uint8Array standar Web Push
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Fungsi utama pendaftaran notifikasi
async function registerDevicePushNotification(role, userId = null) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[Push] Browser ini tidak mendukung Web Push Notifications.');
    return { success: false, error: 'Tidak didukung' };
  }

  try {
    // 1. Minta izin ke pengguna jika belum diizinkan
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.log('[Push] Pengguna menolak izin notifikasi.');
      return { success: false, error: 'Izin ditolak' };
    }

    // 2. Tunggu Service Worker siap
    const registration = await navigator.serviceWorker.ready;

    // 3. Ambil VAPID Public Key dari backend server
    const keyRes = await fetch('/api/push/public-key');
    const keyData = await keyRes.json();
    if (!keyData.success || !keyData.publicKey) {
      throw new Error('Gagal mengambil VAPID Public Key dari server');
    }

    // 4. Daftarkan perangkat ke Google FCM / Push Service
    const applicationServerKey = urlBase64ToUint8Array(keyData.publicKey);
    let subscription = await registration.pushManager.getSubscription();

    // Jika belum berlangganan atau kunci berbeda, subscribe ulang
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });
    }

    // 5. Kirim token perangkat ke database backend kita
    const saveRes = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: role,
        userId: userId,
        subscription: subscription
      })
    });

    const saveResult = await saveRes.json();
    console.log('[Push] Perangkat berhasil terhubung ke sistem notifikasi:', saveResult);
    return { success: true, subscription };
  } catch (err) {
    console.error('[Push] Gagal mendaftarkan push notification:', err);
    return { success: false, error: err.message };
  }
}