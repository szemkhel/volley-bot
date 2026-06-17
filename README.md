# 🏐 Volley Bot

Bot WhatsApp dla naszej grupy siatkarskiej. Tworzy cotygodniowe ankiety, przypomina
o głosowaniu, liczy frekwencję, dzieli koszt sali i udostępnia kalendarz treningów.

## 📅 Kalendarz treningów

Dodaj kalendarz do telefonu/komputera, żeby zawsze widzieć najbliższy trening
(aktualizuje się automatycznie, gdy zmienia się dzień lub godzina):

**Link:** `https://raw.githubusercontent.com/szemkhel/volley-bot/calendar/calendar.ics`

- **Google Calendar (komputer):** Inne kalendarze → ➕ → *Z adresu URL* → wklej link → *Dodaj kalendarz*
- **iPhone:** Ustawienia → Kalendarz → Konta → Dodaj konto → Inne → *Dodaj subskrybowany kalendarz* → wklej link
- **Android:** najłatwiej dodać przez Google Calendar na komputerze — pojawi się też w telefonie

> Aplikacje odświeżają subskrybowany kalendarz co kilka godzin, więc zmiana terminu pojawia się z lekkim opóźnieniem.

## 💬 Komendy

Wszystkie komendy piszesz **na grupie**, zaczynając od słowa **`bot`**.

### Ankieta i głosowanie
- `bot ankieta piątek 20:00` — tworzy nową ankietę na trening. Opcje: **Gram**, **Nie gram**, **Nie wiem**, **Gram i przyprowadzam +1**, **Gram i przyprowadzam +2**
- `bot status` — liczba graczy na najbliższy trening
- `bot przypomnij` — wysyła przypomnienie do osób, które jeszcze nie zagłosowały

### Zmiany terminu
- `bot zmień dzień na czwartek` — zmienia dzień treningu
- `bot zmień godzinę 21:00` — zmienia godzinę
- `bot gramy w czwartek` — ustawia dzień gry
- `bot nie gramy` — odwołuje trening w tym tygodniu
- `bot cofnij odwołanie` — przywraca odwołany trening

### Statystyki
- `bot frekwencja` — ostatnie 10 ankiet (data, liczba graczy, grane/odwołane)
- `bot ranking` — ranking obecności graczy (kto gra najczęściej)

### Rozliczenie sali
- `bot rozlicz` — bot zapyta o koszt sali i liczbę graczy, podzieli koszt i wskaże komu ile zapłacić (osoby z +1/+2 płacą za gości), z numerem BLIK
- `bot rozlicz 100 10` — to samo, ale od razu z danymi (100 zł, 10 osób)

### Inne
- `bot pomoc` — pełna lista komend

## 🤖 Co bot robi automatycznie
- **Poniedziałek 8:00** — wystawia ankietę na najbliższy trening (domyślnie piątek 20:00)
- **Przypomnienia** — wtorek 18:00 (pierwsze) i środa 17:00 (ostatnie) dla piątkowego treningu; terminy przesuwają się, gdy gramy w inny dzień
- **Wtorek 12:00** — jeśli nie ma ankiety, pyta grupę czy gramy
- **Po treningu** — automatycznie zapisuje frekwencję
- Czyta wiadomości przy ankiecie i sam wykrywa, gdy gramy w inny dzień niż zwykle

## 🛠️ Współtworzenie

Kod jest otwarty — Pull Requesty mile widziane!

1. Zrób forka lub gałąź od `main`
2. Wprowadź zmiany i otwórz **Pull Request** do `main`
3. Po zatwierdzeniu i merge'u zmiany **automatycznie wdrażają się** na serwer w ~3 minuty

> Gałąź `main` jest chroniona — zmiany tylko przez Pull Request. Bot zawsze działa na `main`.

### Lokalne uruchomienie
```bash
npm ci
cp .env.example .env        # uzupełnij sekrety (poza gitem)
cp config.example.json config.json
node index.js
```

Sekrety (klucze API, numery) trzymamy w `.env` (ignorowane przez gita). **Nigdy nie commituj prawdziwych danych.**

### Stos technologiczny
- Node.js + [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web)
- Claude (Anthropic) — generowanie wiadomości po polsku
- node-cron — harmonogram zadań
