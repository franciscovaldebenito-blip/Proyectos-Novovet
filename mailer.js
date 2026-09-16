import nodemailer from 'nodemailer';

// Transportador SMTP usando Puerto 587 (Compatible con Render)
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // Debe ser false para el puerto 587 (usa STARTTLS)
  auth: {
    user: process.env.GMAIL_USER || 'informacion@novovet.cl',
    pass: process.env.GMAIL_PASS || 'ycuaygsqjrhnklzn'
  },
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