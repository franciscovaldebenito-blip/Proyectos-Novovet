import nodemailer from 'nodemailer';

// Transportador SMTP de Google Workspace
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: 'informacion@novovet.cl', // ⚠️ Reemplaza con tu correo de Google Corporativo
    pass: 'ycuaygsqjrhnklzn'                    // La contraseña de aplicación generada
  }
});

/**
 * Función para enviar correos electrónicos
 */
export async function enviarCorreo({ to, subject, html }) {
  if (!to) return false;

  try {
    const info = await transporter.sendMail({
      from: '"Gestión de Proyectos" <tu-correo-corporativo@tuempresa.com>', // ⚠️ Reemplaza con tu correo
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