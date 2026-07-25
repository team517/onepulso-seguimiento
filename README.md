# OnePulso · Seguimiento

Prototipos estáticos (HTML + JS, sin build):

- `index.html` — portada
- `Plataforma.html` — panel de clientes / follow-ups / tareas
- `Seguimiento.html` — importar conversaciones + calendario de follow-ups con drag & drop
- `assets/` — logo

## Local

```bash
python -m http.server 5173
# http://127.0.0.1:5173
```

## Docker

```bash
docker build -t onepulso-seguimiento .
docker run -p 8080:80 onepulso-seguimiento
# http://localhost:8080
```

## Deploy en EasyPanel

1. Sube este repo a GitHub.
2. En EasyPanel: **Project → + Service → App**.
3. **Source**: GitHub → selecciona este repo y la rama `main`.
4. **Build**: Dockerfile (lo detecta solo).
5. **Domains**: añade un dominio y activa HTTPS. Puerto del contenedor: **80**.
6. **Deploy**. Cada `git push` a `main` puede redeployar (si activas auto-deploy).
