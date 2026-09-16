import nodemailer from 'nodemailer';

// Transportador SMTP con Puerto 465 e IPv4 forzado para Render
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,             // Cambiado a 465 (SSL directo)
  secure: true,          // Cambiado a true para puerto 465
  family: 4,             // 👈 EVITA EL ERROR IPv6 ENETUNREACH EN RENDER
  auth: {
    user: process.env.GMAIL_USER || 'informacion@novovet.cl',
    pass: process.env.GMAIL_PASS || 'ycuaygsqjrhnklzn'
  },
  connectionTimeout: 10000,
  tls: {
    rejectUnauthorized: false
  }
});

/**
 * Función para enviar correos electrónicos
 */
export async function enviarCorreo({ to, subject, html }) {
  if (!to) return false;

  const correoEmisor = process.env.GMAIL_USER || 'informacion@novovet.cl';

  try {
    const info = await transporter.sendMail({
      from: `"Gestión de Proyectos" <${correoEmisor}>`,
      to: to,
      subject: subject,
      html: html
    });
    console.log("📨 Correo enviado con éxito. ID:", info.messageId);
    return true;
  } catch (error) {
    console.error("❌ Error al enviar el correo:", error);
    return false;
  }
}