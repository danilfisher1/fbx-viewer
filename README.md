# FBX Scene Viewer

Просмотрщик архитектурных FBX-сцен (ВПМ / НПМ) прямо в браузере.
Модели **не загружаются на сервер**: файлы выбираются с компьютера и читаются локально.

## Запуск

```bash
npm install
npm run dev
```

Открой http://localhost:8080 → «Выбрать папку» со сценой.

## Возможности

- Drag & drop / выбор папки с FBX, текстурами, geojson и ZIP-архивами
- ВПМ (UDIM) + НПМ (вложенные текстуры)
- Позиция и стекло из geojson
- Свет из `*_Light.fbx`
- Солнце: Утро / День / Вечер / Ночь
- Кнопка «В кадр»

## Проверки

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Деплой (GitHub → Vercel)

Коммить только код — модели (`*.fbx`, `*.zip`) в `.gitignore`.

```bash
git init
git add .
git commit -m "FBX Viewer"
git branch -M main
git remote add origin https://github.com/danilfisher1/fbx-viewer.git
git push -u origin main
```

Vercel подхватит `vercel.json` и `npm run build` автоматически.
