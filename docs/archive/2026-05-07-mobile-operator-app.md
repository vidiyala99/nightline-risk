# Mobile Operator App — Build Tracker

**Stack:** Expo (managed), React Native, TypeScript  
**Location:** `mobile/` in monorepo  
**Status:** In progress

---

## Progress

### Setup
- [ ] Scaffold Expo app — `npx create-expo-app mobile --template blank-typescript`
- [ ] Install dependencies (see list below)
- [ ] Configure `app.json` (name, slug, scheme)
- [ ] Set up `EXPO_PUBLIC_API_URL` env var

### Core Infrastructure
- [ ] `src/api/client.ts` — fetch wrapper with Bearer token injection
- [ ] `src/contexts/AuthContext.tsx` — SecureStore token, same shape as web
- [ ] `App.tsx` — NavigationContainer, auth gate, font loading
- [ ] `src/navigation/TabNavigator.tsx` — bottom tab bar (4 tabs)

### Shared Components
- [ ] `src/components/StatusBadge.tsx` — open/under_review/closed badge
- [ ] `src/components/CapacityBar.tsx` — reusable progress bar

### Screens
- [ ] `LoginScreen.tsx` — email/password, POST /api/auth/login, haptics
- [ ] `DashboardScreen.tsx` — risk score, tier badge, score bars, premium quote
- [ ] `IncidentListScreen.tsx` — list, status filter tabs, pull-to-refresh
- [ ] `ReportIncidentScreen.tsx` — form, camera/gallery picker, evidence upload
- [ ] `LiveTerminalScreen.tsx` — capacity bar, infra grid, compliance queue, 10s poll

### Backend
- [ ] Update CORS in `backend/app/main.py` — add Expo dev origins

### Docs
- [ ] Add `mobile/` setup instructions to root README

---

## Dependencies

```json
{
  "expo": "~52.0.0",
  "expo-secure-store": "~14.0.0",
  "expo-image-picker": "~15.0.0",
  "expo-haptics": "~13.0.0",
  "expo-font": "~13.0.0",
  "@expo-google-fonts/dm-sans": "latest",
  "@expo-google-fonts/cormorant-garamond": "latest",
  "@react-navigation/native": "^6.0.0",
  "@react-navigation/bottom-tabs": "^6.0.0",
  "react-native-safe-area-context": "latest",
  "react-native-screens": "latest"
}
```

---

## API Endpoints Used

| Screen | Endpoint |
|--------|----------|
| Login | `POST /api/auth/login` |
| Dashboard | `GET /api/venues/{id}/risk-score`, `GET /api/venues/{id}/quote` |
| Incident List | `GET /api/venues/{id}/incidents` |
| Report Incident | `POST /api/venues/{id}/incidents`, `POST /api/incidents/{id}/evidence` |
| Live Terminal | `GET /api/venues/{id}/live` |

---

## Design Tokens

| Token | Value |
|-------|-------|
| Background | `#0b0c15` |
| Surface | `#13151f` |
| Brand accent | `#c8f000` |
| Border | `rgba(255,255,255,0.08)` |
| Border radius (card) | `12px` |
| Border radius (button) | `8px` |

---

## Verification Checklist

- [ ] `cd mobile && npx expo start` runs without errors
- [ ] Login with `venue@elsewhere.com / demo123`
- [ ] Report incident with photo → appears in web underwriter queue
- [ ] Live terminal capacity updates on 10s poll
- [ ] Pull-to-refresh on incident list works
- [ ] Sign out clears token, returns to login
