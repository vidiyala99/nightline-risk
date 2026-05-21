Write-Host "Starting Nightline Risk Backend (FastAPI)..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit -Command `"cd backend; uvicorn app.main:app --reload`""

Write-Host "Starting Nightline Risk Frontend (Next.js)..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit -Command `"cd frontend; npm run dev`""

Write-Host "Dashboard is spinning up!" -ForegroundColor Cyan
Write-Host "-> Backend API: http://localhost:8000"
Write-Host "-> Frontend UI: http://localhost:3000"
