# Registro iSleep – RB&RD (Cloudflare Pages + Workers + D1)

Solución completa:
- Frontend: Cloudflare Pages (carpeta `/dashboard`)
- API: Cloudflare Worker (carpeta `/worker`)
- DB: Cloudflare D1 (SQLite)

## Requisitos (Windows 11)
1) Instalar **Node.js LTS** (incluye npm)
2) Instalar **Git**
3) (Recomendado) **VS Code**
4) Cloudflare account (gratis)

## 1) Iniciar desde cero en GitHub
1) Crea un repo vacío en GitHub (ej: `sleep-dashboard`)
2) En tu PC:
```powershell
cd C:\
mkdir sleep-dashboard
# (Opcional) borra carpeta si existe, o usa otro nombre
```
3) Copia el contenido de este ZIP dentro de `C:\sleep-dashboard`
4) Inicializa git y sube:
```powershell
cd C:\sleep-dashboard
git init
git add .
git commit -m "Initial: Registro iSleep RB&RD"
git branch -M main
git remote add origin https://github.com/<TU_USUARIO>/<TU_REPO>.git
git push -u origin main
```

## 2) Worker + D1 (backend)
### 2.1 Login Wrangler
```powershell
npm i -g wrangler
wrangler login
```

### 2.2 Crear D1
```powershell
cd C:\sleep-dashboard\worker
wrangler d1 create sleep_db
```
Copia el `database_id` que te muestre y pégalo en `worker/wrangler.toml` (campo `database_id`).

### 2.3 Crear tablas (schema)
```powershell
wrangler d1 execute sleep_db --file=.\schema.sql --remote
```

> Si ya tenías la DB de versiones anteriores y falta la columna `status`:
```powershell
wrangler d1 execute sleep_db --file=.\migrations\001_add_status.sql --remote
```

### 2.4 Configurar API_KEY (secret)
```powershell
wrangler secret put API_KEY
```
Pega tu API key (por ejemplo: `RBYRD_SLEEP_2026__...`)

### 2.5 Deploy Worker
```powershell
wrangler deploy
```

## 3) Cloudflare Pages (frontend)
En Cloudflare Dashboard:
- Workers & Pages -> Pages -> Create project -> Connect GitHub
- Selecciona tu repo
- Build:
  - Framework: None
  - Build command: (vacío)
  - Output directory: `dashboard`
- Deploy

Tu URL será algo como:
`https://<proyecto>.pages.dev`

## 4) Probar localmente el dashboard
```powershell
cd C:\sleep-dashboard\dashboard
npx serve .
```
Abre:
http://localhost:3000

## 5) Crear datos DEMO (3 ejemplos)
En la página “Mensual” tienes botones:
- “Crear datos demo”
- “Borrar datos demo”
Te pedirá API KEY.

También por curl:
```powershell
$api="https://<tu-worker>.workers.dev"
$h=@{"X-API-KEY"="TU_API_KEY";"Content-Type"="application/json"}
Invoke-RestMethod -Method Post -Uri "$api/api/demo/seed" -Headers $h
Invoke-RestMethod -Method Delete -Uri "$api/api/demo/clear" -Headers $h
```

## 6) OCR fallido (Pendiente)
Cuando el bot no pueda leer:
- Enviar `status:"PENDING"` y `pdf_url` / `image_url`
Ejemplo:
```json
{
  "worker_name": "Luis Gomez",
  "date": "2026-01-12",
  "status": "PENDING",
  "source": "telegram",
  "image_url": "https://.../image.jpg",
  "pdf_url": "https://.../file.pdf",
  "raw_text": "OCR failed"
}
```

## 7) Feriados
En “Mensual”:
- “Cargar feriados (2026–2030)” (Perú) -> requiere API KEY
- Puedes agregar feriados manuales (ej: aniversario empresa) o eliminarlos.
