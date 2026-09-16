/**
 * Envío de correos mediante Google Apps Script Web App
 */
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxUNmvTdTmhEGiPqvNNUDRO2eHUcOzt5jka5UFpMNHAwaZjTZdkpu-sxn24JXIZcWClCQ/exec';

export async function enviarCorreo({ to, subject, html }) {
  if (!to) return false;

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'text/plain;charset=utf-8' // Se usa text/plain para evitar bloqueos por Preflight CORS en Apps Script
      },
      body: JSON.stringify({ to, subject, html }),
      redirect: 'follow' // Indispensable para manejar la redirección 302 que realiza Google
    });

    const result = await response.json();

    if (result.success) {
      console.log("📨 Correo enviado con éxito vía Google Apps Script.");
      return true;
    } else {
      console.error("❌ Error en Apps Script:", result.error);
      return false;
    }
  } catch (error) {
    console.error("❌ Error de red al conectar con Google Apps Script:", error);
    return false;
  }
}