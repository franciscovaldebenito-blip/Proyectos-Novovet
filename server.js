import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { enviarCorreo } from './mailer.js'; // 👈 IMPORTACIÓN DE MAILER

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// FUNCIÓN AUXILIAR PARA FORMATEAR FECHA A DD/MM/AAAA
const formatearFecha = (fechaStr) => {
  if (!fechaStr) return 'Sin definir';
  const fechaLimpia = fechaStr.split('T')[0]; // Remueve horas si existen
  const [year, month, day] = fechaLimpia.split('-');
  if (!year || !month || !day) return fechaStr;
  return `${day}/${month}/${year}`;
};

// MIDDLEWARE DE AUTENTICACIÓN
const verificarAutenticacion = async (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'No autorizado' });

  const { data: profile } = await db
    .from('pm_profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (!profile) return res.status(401).json({ error: 'Usuario no encontrado' });

  req.user = profile;
  next();
};

// Actualizar el estado de un proyecto
app.patch('/api/projects/:id/status', verificarAutenticacion, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) return res.status(400).json({ error: 'El estado es requerido' });

    const { data, error } = await db
      .from('pm_projects')
      .update({ status })
      .eq('id', id)
      .select();

    if (error) throw error;

    res.json({ message: 'Estado actualizado correctamente', project: data[0] });
  } catch (err) {
    console.error('Error en PATCH /api/projects/:id/status:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// 1. INICIO DE SESIÓN
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  // 💡 Limpiamos el email: quitamos espacios y convertimos a minúsculas
  const cleanEmail = (email || '').trim().toLowerCase();

  try {
    const { data: profile, error } = await db
      .from('pm_profiles')
      .select('*')
      .ilike('email', cleanEmail) // 💡 ilike busca sin importar mayúsculas/minúsculas en Supabase
      .maybeSingle();

    if (error || !profile) {
      return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });
    }

    if (profile.password && profile.password !== password) {
      return res.status(400).json({ error: 'Contraseña incorrecta' });
    }

    res.json({
      token: profile.id,
      user: profile
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// 2. PROYECTOS
app.get('/api/projects', verificarAutenticacion, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const { data: allProjects, error } = await db
        .from('pm_projects')
        .select('*, pm_profiles:user_id(full_name, email, area)');

      if (error) throw error;
      return res.json({ own: allProjects || [], collab: [] });
    }

    const { data: own } = await db
      .from('pm_projects')
      .select('*, pm_profiles:user_id(full_name, email, area)')
      .eq('user_id', req.user.id);

    const { data: tasks, error: taskErr } = await db
      .from('pm_tasks')
      .select('*, pm_projects:project_id(id, title, user_id, priority, pm_profiles:user_id(full_name))')
      .eq('assigned_to', req.user.id);

    if (taskErr) throw taskErr;

    const collabTasks = (tasks || []).map(t => ({
      task_id: t.id,
      task_title: t.title,
      project_id: t.project_id,
      project_title: t.pm_projects?.title || '---',
      project_owner: t.pm_projects?.pm_profiles?.full_name || '---',
      project_priority: t.pm_projects?.priority || 'media',
      due_date: t.due_date,
      updated_at: t.updated_at || t.created_at,
      status: t.status
    }));

    res.json({ own: own || [], collab: collabTasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', verificarAutenticacion, async (req, res) => {
  const { 
    title, 
    description, 
    notes, 
    user_id, 
    status, 
    priority, 
    start_date, 
    due_date, 
    end_date 
  } = req.body;
  
  // 🔴 VALIDACIONES EN BACKEND
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'El título del proyecto es obligatorio' });
  }

  const fechaFin = due_date || end_date;
  if (!start_date || !fechaFin) {
    return res.status(400).json({ error: 'Las fechas de inicio y término del proyecto son obligatorias' });
  }

  try {
    const ownerId = (req.user.role === 'admin' && user_id) ? user_id : req.user.id;

    const { data, error } = await db
      .from('pm_projects')
      .insert([{
        title: title.trim(),
        description: description && description.trim() !== '' ? description.trim() : null,
        notes: notes && notes.trim() !== '' ? notes.trim() : null,
        user_id: ownerId,
        status: status || 'PLANNING',
        priority: priority || 'media',
        start_date: start_date,
        due_date: fechaFin
      }])
      .select();

    if (error) {
      console.error('Error al insertar proyecto en Supabase:', error);
      return res.status(400).json({ error: error.message });
    }

    const nuevoProyecto = data[0];

    // 📧 NOTIFICACIÓN POR CORREO AL CREAR O ASIGNAR PROYECTO
    (async () => {
      try {
        const { data: ownerProfile } = await db
          .from('pm_profiles')
          .select('full_name, email')
          .eq('id', ownerId)
          .single();

        if (ownerProfile?.email) {
          enviarCorreo({
            to: ownerProfile.email,
            subject: `📂 Nuevo Proyecto Asignado: ${nuevoProyecto.title}`,
            html: `
              <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                <h2 style="color: #0f766e; margin-top: 0;">Nuevo Proyecto Creado</h2>
                <p>Hola <strong>${ownerProfile.full_name}</strong>,</p>
                <p>Se te ha asignado como responsable del proyecto: <strong>"${nuevoProyecto.title}"</strong>.</p>
                <div style="background-color: #f8fafc; padding: 12px; border-left: 4px solid #0f766e; margin: 15px 0;">
                  <p style="margin: 0;"><strong>Prioridad:</strong> ${nuevoProyecto.priority}</p>
                  <p style="margin: 5px 0 0 0;"><strong>Fecha de Cierre:</strong> ${formatearFecha(nuevoProyecto.due_date)}</p>
                </div>
                <p style="font-size: 12px; color: #64748b;">Accede al sistema para gestionar las acciones y tareas asociadas.</p>
              </div>
            `
          });
        }
      } catch (e) {
        console.error("Error al enviar notificación de proyecto:", e);
      }
    })();

    res.status(201).json(nuevoProyecto);
  } catch (err) {
    console.error('Error en servidor al crear proyecto:', err);
    res.status(500).json({ error: err.message });
  }
});


// 3. BITÁCORA DEL PROYECTO (pm_project_comments)
app.get('/api/projects/:projectId/comments', verificarAutenticacion, async (req, res) => {
  try {
    const { data: comments, error } = await db
      .from('pm_project_comments')
      .select('*')
      .eq('project_id', req.params.projectId)
      .order('created_at', { ascending: true });

    if (error) return res.status(400).json({ error: error.message });
    if (!comments || comments.length === 0) return res.json([]);

    const userIds = [...new Set(comments.map(c => c.user_id).filter(Boolean))];
    let profilesMap = {};

    if (userIds.length > 0) {
      const { data: profiles } = await db
        .from('pm_profiles')
        .select('id, full_name, email')
        .in('id', userIds);

      if (profiles) {
        profilesMap = profiles.reduce((acc, p) => {
          acc[p.id] = p;
          return acc;
        }, {});
      }
    }

    const result = comments.map(c => ({
      ...c,
      pm_profiles: profilesMap[c.user_id] || { full_name: 'Usuario', email: '' }
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:projectId/comments', verificarAutenticacion, async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim() === '') {
    return res.status(400).json({ error: 'El mensaje de avance no puede estar vacío.' });
  }

  try {
    const { data, error } = await db
      .from('pm_project_comments')
      .insert([{
        project_id: req.params.projectId,
        user_id: req.user.id,
        text: text.trim()
      }])
      .select();

    if (error) return res.status(400).json({ error: error.message });

    const responseData = {
      ...data[0],
      pm_profiles: {
        full_name: req.user.full_name,
        email: req.user.email
      }
    };

    res.status(201).json(responseData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id/notes', verificarAutenticacion, async (req, res) => {
  try {
    const { data } = await db.from('pm_projects').select('notes').eq('id', req.params.id).single();
    res.json({ notes: data?.notes || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/projects/:id', verificarAutenticacion, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const { data, error } = await db
      .from('pm_projects')
      .update(updates)
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/projects/:id/notes', verificarAutenticacion, async (req, res) => {
  const { notes } = req.body;
  try {
    const { data, error } = await db
      .from('pm_projects')
      .update({ notes })
      .eq('id', req.params.id)
      .select('notes');

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. PERFILES
app.get('/api/profiles', verificarAutenticacion, async (req, res) => {
  try {
    const { data, error } = await db
      .from('pm_profiles')
      .select('id, full_name, email, role, area');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. TAREAS / ACCIONES
app.get('/api/projects/:id/tasks', verificarAutenticacion, async (req, res) => {
  try {
    const { data, error } = await db
      .from('pm_tasks')
      .select('*')
      .eq('project_id', req.params.id);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/in-progress', verificarAutenticacion, async (req, res) => {
  try {
    const { data: tareas, error: errTareas } = await db
      .from('pm_tasks')
      .select('id, project_id, title, status, priority, start_date, due_date, created_at, assigned_to')
      .neq('status', 'finalizado');

    if (errTareas) throw errTareas;
    if (!tareas || tareas.length === 0) return res.json([]);

    const projectIds = [...new Set(tareas.map(t => t.project_id).filter(Boolean))];
    const userIds = [...new Set(tareas.map(t => t.assigned_to).filter(Boolean))];
    const taskIds = tareas.map(t => t.id);

    const [resProjects, resProfiles, resComments] = await Promise.all([
      projectIds.length ? db.from('pm_projects').select('id, title, description, user_id').in('id', projectIds) : { data: [] },
      userIds.length ? db.from('pm_profiles').select('id, full_name, email').in('id', userIds) : { data: [] },
      taskIds.length ? db.from('pm_comments').select('id, task_id, created_at').in('task_id', taskIds) : { data: [] }
    ]);

    const proyectos = resProjects.data || [];
    const perfiles = resProfiles.data || [];
    const comentarios = resComments.data || [];

    const ownerIds = [...new Set(proyectos.map(p => p.user_id).filter(Boolean))];
    let ownerProfilesMap = {};
    if (ownerIds.length > 0) {
      const { data: owners } = await db.from('pm_profiles').select('id, full_name').in('id', ownerIds);
      if (owners) {
        ownerProfilesMap = owners.reduce((acc, o) => { acc[o.id] = o.full_name; return acc; }, {});
      }
    }

    const resultado = tareas.map(t => {
      const proj = proyectos.find(p => String(p.id) === String(t.project_id));
      const prof = perfiles.find(p => String(p.id) === String(t.assigned_to));
      const comms = comentarios.filter(c => String(c.task_id) === String(t.id));

      const projOwnerName = proj ? (ownerProfilesMap[proj.user_id] || 'Sin Asignar') : 'Sin Asignar';

      const ultComentario = comms.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      const ultimaAct = ultComentario ? ultComentario.created_at : t.created_at;

      return {
        id: t.id,
        task_id: t.id,
        title: t.title,
        task_title: t.title,
        assigned_to_name: prof?.full_name || 'Sin Asignar',
        project_title: proj?.title || 'Sin Proyecto',
        project_owner: projOwnerName,
        start_date: t.start_date,
        due_date: t.due_date,
        updated_at: ultimaAct,
        status: t.status || 'pendiente',
        priority: t.priority || 'media',
        pm_projects: proj ? { ...proj, pm_profiles: { full_name: projOwnerName } } : null,
        assigned_profile: prof || null,
        pm_comments: comms || []
      };
    });

    res.json(resultado);
  } catch (err) {
    console.error('Error interno en /api/tasks/in-progress:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/completed', verificarAutenticacion, async (req, res) => {
  try {
    const { data: tareas, error: errTareas } = await db
      .from('pm_tasks')
      .select('id, project_id, title, status, priority, start_date, due_date, created_at, assigned_to')
      .eq('status', 'finalizado');

    if (errTareas) throw errTareas;
    if (!tareas || tareas.length === 0) return res.json([]);

    const projectIds = [...new Set(tareas.map(t => t.project_id).filter(Boolean))];
    const userIds = [...new Set(tareas.map(t => t.assigned_to).filter(Boolean))];
    const taskIds = tareas.map(t => t.id);

    const [resProjects, resProfiles, resComments] = await Promise.all([
      projectIds.length ? db.from('pm_projects').select('id, title, description, user_id').in('id', projectIds) : { data: [] },
      userIds.length ? db.from('pm_profiles').select('id, full_name, email').in('id', userIds) : { data: [] },
      taskIds.length ? db.from('pm_comments').select('id, task_id, text, created_at').in('task_id', taskIds) : { data: [] }
    ]);

    const proyectos = resProjects.data || [];
    const perfiles = resProfiles.data || [];
    const comentarios = resComments.data || [];

    const ownerIds = [...new Set(proyectos.map(p => p.user_id).filter(Boolean))];
    let ownerProfilesMap = {};
    if (ownerIds.length > 0) {
      const { data: owners } = await db.from('pm_profiles').select('id, full_name').in('id', ownerIds);
      if (owners) {
        ownerProfilesMap = owners.reduce((acc, o) => { acc[o.id] = o.full_name; return acc; }, {});
      }
    }

    const resultado = tareas.map(t => {
      const proj = proyectos.find(p => String(p.id) === String(t.project_id));
      const prof = perfiles.find(p => String(p.id) === String(t.assigned_to));
      const comms = comentarios.filter(c => String(c.task_id) === String(t.id));

      const projOwnerName = proj ? (ownerProfilesMap[proj.user_id] || 'Sin Asignar') : 'Sin Asignar';

      return {
        ...t,
        pm_projects: proj ? { ...proj, pm_profiles: { full_name: projOwnerName } } : null,
        assigned_profile: prof || null,
        pm_comments: comms || []
      };
    });

    res.json(resultado);
  } catch (err) {
    console.error('Error interno en /api/tasks/completed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id', verificarAutenticacion, async (req, res) => {
  const { id } = req.params;

  try {
    const { data: task, error } = await db
      .from('pm_tasks')
      .select(`
        *,
        pm_projects:project_id(id, title),
        assigned_profile:assigned_to(full_name, email)
      `)
      .eq('id', id)
      .single();

    if (error || !task) {
      return res.status(404).json({ error: 'La acción no fue encontrada' });
    }

    res.json(task);
  } catch (err) {
    console.error('Error al obtener la tarea:', err);
    res.status(500).json({ error: err.message });
  }
});

// Crear nueva acción (+ Correo de notificación con fecha formateada DD/MM/AAAA)
// 2. RUTA DE TAREAS/ACCIONES (Actualizada con validación de fechas)
app.post('/api/tasks', verificarAutenticacion, async (req, res) => {
  const { 
    project_id, 
    title, 
    description, 
    comments, 
    priority, 
    assigned_to, 
    start_date, 
    due_date 
  } = req.body;

  // 🔴 VALIDACIONES EN BACKEND
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'El título de la acción es obligatorio' });
  }

  if (!start_date || !due_date) {
    return res.status(400).json({ error: 'Las fechas de inicio y término de la acción son obligatorias' });
  }

  try {
    const { data, error } = await db
      .from('pm_tasks')
      .insert([{ 
        project_id, 
        title: title.trim(), 
        description: description && description.trim() !== '' ? description.trim() : null,
        comments: comments && comments.trim() !== '' ? comments.trim() : null,
        priority: priority || 'low',
        assigned_to: assigned_to || null, 
        start_date: start_date, 
        due_date: due_date, 
        status: 'pendiente' 
      }])
      .select();

    if (error) {
      console.error('Error al insertar en Supabase:', error);
      return res.status(400).json({ error: error.message });
    }

    const nuevaTarea = data[0];

    // 📧 NOTIFICACIÓN POR CORREO AL ASIGNAR ACCIÓN
    if (assigned_to) {
      (async () => {
        try {
          const [resUser, resProj] = await Promise.all([
            db.from('pm_profiles').select('full_name, email').eq('id', assigned_to).single(),
            db.from('pm_projects').select('title').eq('id', project_id).single()
          ]);

          const userAssigned = resUser.data;
          const projectAssigned = resProj.data;

          if (userAssigned?.email) {
            enviarCorreo({
              to: userAssigned.email,
              subject: `⚡ Nueva Acción Asignada: ${nuevaTarea.title}`,
              html: `
                <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                  <h2 style="color: #0f766e; margin-top: 0;">Tienes una nueva acción asignada</h2>
                  <p>Hola <strong>${userAssigned.full_name}</strong>,</p>
                  <p>Se te ha asignado una acción en el proyecto <strong>"${projectAssigned?.title || 'Sin Nombre'}"</strong>:</p>
                  <div style="background-color: #f8fafc; padding: 12px; border-left: 4px solid #0f766e; margin: 15px 0;">
                    <p style="margin: 0; font-weight: bold; color: #1e293b;">${nuevaTarea.title}</p>
                    <p style="margin: 5px 0 0 0; font-size: 12px; color: #64748b;"><strong>Fecha Límite:</strong> ${formatearFecha(nuevaTarea.due_date)}</p>
                  </div>
                  <p style="font-size: 12px; color: #64748b;">Ingresa a la plataforma para ver el detalle y actualizar la bitácora.</p>
                </div>
              `
            });
          }
        } catch (e) {
          console.error("Error enviando correo de asignación de tarea:", e);
        }
      })();
    }

    res.status(201).json(nuevaTarea);
  } catch (err) {
    console.error('Error en el servidor:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id/status', verificarAutenticacion, async (req, res) => {
  const { status } = req.body;
  try {
    const { data, error } = await db
      .from('pm_tasks')
      .update({ status })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/completed-list', verificarAutenticacion, async (req, res) => {
  try {
    const { data: tareas, error: errTareas } = await db
      .from('pm_tasks')
      .select('*')
      .eq('status', 'finalizado');

    if (errTareas) throw errTareas;
    if (!tareas || tareas.length === 0) return res.json([]);

    const taskIds = tareas.map(t => t.id);
    const projectIds = [...new Set(tareas.map(t => t.project_id).filter(Boolean))];

    const [resComments, resProjects] = await Promise.all([
      taskIds.length ? db.from('pm_comments').select('*').in('task_id', taskIds).order('created_at', { ascending: false }) : { data: [] },
      projectIds.length ? db.from('pm_projects').select('*').in('id', projectIds) : { data: [] }
    ]);

    const comentarios = resComments.data || [];
    const proyectos = resProjects.data || [];

    const ownerIds = [...new Set(proyectos.map(p => p.user_id).filter(Boolean))];
    let ownerProfilesMap = {};
    if (ownerIds.length > 0) {
      const { data: owners } = await db.from('pm_profiles').select('id, full_name, email').in('id', ownerIds);
      if (owners) {
        ownerProfilesMap = owners.reduce((acc, o) => {
          acc[o.id] = o.full_name || o.email;
          return acc;
        }, {});
      }
    }

    const resultado = tareas.map(t => {
      const proj = proyectos.find(p => String(p.id) === String(t.project_id));
      const comms = comentarios.filter(c => String(c.task_id) === String(t.id));
      
      const duenoProyecto = proj ? (ownerProfilesMap[proj.user_id] || 'Sin Asignar') : 'Sin Asignar';
      
      return {
        ...t,
        assigned_to: t.assigned_to,
        pm_projects: {
          title: proj ? proj.title : 'Proyecto Sin Nombre',
          pm_profiles: { full_name: duenoProyecto }
        },
        pm_comments: comms
      };
    });

    res.json(resultado);
  } catch (err) {
    console.error('Error detallado en /api/tasks/completed-list:', err);
    res.status(500).json({ error: err.message });
  }
});

// 6. HISTORIAL DE AVANCES DE LA TAREA (TABLA pm_comments)
app.get('/api/tasks/:taskId/comments', verificarAutenticacion, async (req, res) => {
  try {
    const { data: comments, error: commentsError } = await db
      .from('pm_comments')
      .select('*')
      .eq('task_id', req.params.taskId)
      .order('created_at', { ascending: true });

    if (commentsError) {
      console.error('Error Supabase (comments):', commentsError);
      return res.status(400).json({ error: commentsError.message });
    }

    if (!comments || comments.length === 0) {
      return res.json([]);
    }

    const userIds = [...new Set(comments.map(c => c.user_id).filter(Boolean))];
    let profilesMap = {};

    if (userIds.length > 0) {
      const { data: profiles } = await db
        .from('pm_profiles')
        .select('id, full_name, email')
        .in('id', userIds);

      if (profiles) {
        profilesMap = profiles.reduce((acc, p) => {
          acc[p.id] = p;
          return acc;
        }, {});
      }
    }

    const result = comments.map(c => ({
      ...c,
      pm_profiles: profilesMap[c.user_id] || { full_name: 'Usuario', email: '' }
    }));

    res.json(result);
  } catch (err) {
    console.error('Error interno en GET comments:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:taskId/comments', verificarAutenticacion, async (req, res) => {
  const { text } = req.body;
  
  if (!text || text.trim() === '') {
    return res.status(400).json({ error: 'El texto del comentario no puede estar vacío.' });
  }

  try {
    const { data, error } = await db
      .from('pm_comments')
      .insert([{
        task_id: req.params.taskId,
        user_id: req.user.id,
        text: text.trim()
      }])
      .select();

    if (error) {
      console.error('Error Supabase (insert comment):', error);
      return res.status(400).json({ error: error.message });
    }

    const responseData = {
      ...data[0],
      pm_profiles: {
        full_name: req.user.full_name,
        email: req.user.email
      }
    };

    res.status(201).json(responseData);
  } catch (err) {
    console.error('Error interno en POST comments:', err);
    res.status(500).json({ error: err.message });
  }
});

// 7. GESTIÓN DE ACCESOS Y USUARIOS
app.post('/api/users', verificarAutenticacion, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo los administradores pueden gestionar usuarios.' });
  }

  const { email, password, full_name, role, area } = req.body;

  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'Email, contraseña y nombre completo son obligatorios.' });
  }

  try {
    const { data: existing } = await db
      .from('pm_profiles')
      .select('id')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ error: 'Ya existe un usuario registrado con este correo.' });
    }

    const { data, error } = await db
      .from('pm_profiles')
      .insert([{
        email: email.trim().toLowerCase(),
        password: password.trim(),
        full_name: full_name.trim(),
        role: role || 'user',
        area: area && area.trim() !== '' ? area.trim() : null
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/users/:id', verificarAutenticacion, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  const { full_name, role, area } = req.body;

  try {
    const { data, error } = await db
      .from('pm_profiles')
      .update({
        full_name: full_name?.trim(),
        role: role || 'user',
        area: area && area.trim() !== '' ? area.trim() : null
      })
      .eq('id', req.params.id)
      .select();

    if (error) throw error;
    res.json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/users/:id/password', verificarAutenticacion, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
    return res.status(403).json({ error: 'No tienes permiso para modificar esta contraseña.' });
  }

  const { password } = req.body;
  if (!password || password.trim() === '') {
    return res.status(400).json({ error: 'La contraseña no puede estar vacía.' });
  }

  try {
    const { data, error } = await db
      .from('pm_profiles')
      .update({ password: password.trim() })
      .eq('id', req.params.id)
      .select('id, email, full_name');

    if (error) throw error;
    res.json({ message: 'Contraseña actualizada con éxito', user: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ACTUALIZAR FECHA DE CIERRE DE UN PROYECTO
app.patch('/api/projects/:id/due-date', verificarAutenticacion, async (req, res) => {
  const { due_date, reason } = req.body;
  const projectId = req.params.id;

  if (!due_date || !reason || reason.trim() === '') {
    return res.status(400).json({ error: 'La fecha de cierre y el motivo del cambio son obligatorios.' });
  }

  try {
    const { data: project, error: fetchErr } = await db
      .from('pm_projects')
      .select('user_id, due_date')
      .eq('id', projectId)
      .single();

    if (fetchErr || !project) return res.status(404).json({ error: 'Proyecto no encontrado' });

    if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Solo el dueño del proyecto puede modificar la fecha de cierre.' });
    }

    const prevDate = project.due_date ? formatearFecha(project.due_date) : 'Sin fecha';
    const newFormattedDate = formatearFecha(due_date);

    const { data: updatedProject, error: updateErr } = await db
      .from('pm_projects')
      .update({ due_date })
      .eq('id', projectId)
      .select();

    if (updateErr) throw updateErr;

    const logMessage = `📅 Cambio de fecha de cierre del proyecto: de ${prevDate} a ${newFormattedDate}. Motivo: ${reason.trim()}`;
    await db.from('pm_project_comments').insert([{
      project_id: projectId,
      user_id: req.user.id,
      text: logMessage
    }]);

    res.json(updatedProject[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ELIMINAR PROYECTO Y TODAS SUS TAREAS/ACCIONES ASOCIADAS
app.delete('/api/projects/:id', verificarAutenticacion, async (req, res) => {
  const { id } = req.params;

  try {
    // 1. Obtener las IDs de todas las tareas del proyecto
    const { data: tasks } = await db
      .from('pm_tasks')
      .select('id')
      .eq('project_id', id);

    if (tasks && tasks.length > 0) {
      const taskIds = tasks.map(t => t.id);

      // 2. Eliminar comentarios de las tareas
      await db.from('pm_comments').delete().in('task_id', taskIds);

      // 3. Eliminar las tareas del proyecto
      await db.from('pm_tasks').delete().eq('project_id', id);
    }

    // 4. Eliminar comentarios/bitácora del proyecto
    await db.from('pm_project_comments').delete().eq('project_id', id);

    // 5. Eliminar el proyecto
    const { error } = await db
      .from('pm_projects')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'Proyecto y sus acciones asociadas fueron eliminados correctamente.' });
  } catch (err) {
    console.error('Error al eliminar proyecto:', err);
    res.status(500).json({ error: err.message });
  }
});


// ACTUALIZAR FECHA DE CIERRE DE UNA TAREA
app.patch('/api/tasks/:id/due-date', verificarAutenticacion, async (req, res) => {
  const { due_date, reason } = req.body;
  const taskId = req.params.id;

  if (!due_date || !reason || reason.trim() === '') {
    return res.status(400).json({ error: 'La fecha de cierre y el motivo del cambio son obligatorios.' });
  }

  try {
    const { data: task, error: fetchErr } = await db
      .from('pm_tasks')
      .select('due_date, pm_projects:project_id(user_id)')
      .eq('id', taskId)
      .single();

    if (fetchErr || !task) return res.status(404).json({ error: 'Tarea no encontrada' });

    const ownerId = task.pm_projects?.user_id;
    if (req.user.role !== 'admin' && ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Solo el dueño del proyecto puede modificar la fecha de la tarea.' });
    }

    const prevDate = task.due_date ? formatearFecha(task.due_date) : 'Sin fecha';
    const newFormattedDate = formatearFecha(due_date);

    const { data: updatedTask, error: updateErr } = await db
      .from('pm_tasks')
      .update({ due_date })
      .eq('id', taskId)
      .select();

    if (updateErr) throw updateErr;

    const logMessage = `📅 Cambio de fecha de cierre de la acción: de ${prevDate} a ${newFormattedDate}. Motivo: ${reason.trim()}`;
    await db.from('pm_comments').insert([{
      task_id: taskId,
      user_id: req.user.id,
      text: logMessage
    }]);

    res.json(updatedTask[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ruta para eliminar una acción/tarea con validación de dueño
// Ruta para eliminar una tarea / acción (Solo el dueño del proyecto)
app.delete('/api/tasks/:id', verificarAutenticacion, async (req, res) => {
  const taskId = req.params.id;
  const currentUserId = req.user.id; // ID del usuario autenticado obtenido por el middleware

  try {
    // 1. Obtener la tarea y el owner del proyecto asociado
    const { data: task, error: taskError } = await db
      .from('pm_tasks')
      .select('id, project_id')
      .eq('id', taskId)
      .single();

    if (taskError || !task) {
      return res.status(404).json({ error: 'La acción o tarea no existe.' });
    }

    // 2. Obtener el proyecto para validar el dueño (user_id)
    const { data: project, error: projError } = await db
      .from('pm_projects')
      .select('user_id')
      .eq('id', task.project_id)
      .single();

    if (projError || !project) {
      return res.status(404).json({ error: 'No se encontró el proyecto asociado.' });
    }

    // 3. Verificar si el usuario actual es el dueño del proyecto (o admin)
    const esDuenioProyecto = String(project.user_id) === String(currentUserId);
    const esAdmin = req.user.role === 'admin';

    if (!esDuenioProyecto && !esAdmin) {
      return res.status(403).json({ 
        error: 'Permiso denegado. Solo el dueño del proyecto puede eliminar acciones.' 
      });
    }

    // 4. Eliminar la tarea
    const { error: deleteError } = await db
      .from('pm_tasks')
      .delete()
      .eq('id', taskId);

    if (deleteError) {
      console.error('Error al eliminar tarea:', deleteError);
      return res.status(400).json({ error: deleteError.message });
    }

    return res.status(200).json({ message: 'Acción eliminada con éxito.' });

  } catch (err) {
    console.error('Error en el servidor al eliminar tarea:', err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));