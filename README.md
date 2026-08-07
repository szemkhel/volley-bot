# 🏐 Volley Bot

Bot WhatsApp dla naszej grupy siatkarskiej. Tworzy cotygodniowe ankiety, przypomina
o głosowaniu, liczy frekwencję, dzieli koszt sali i udostępnia kalendarz treningów.

## 📅 Kalendarz treningów

Dodaj kalendarz do telefonu/komputera, żeby zawsze widzieć najbliższy trening
(aktualizuje się automatycznie, gdy zmienia się dzień lub godzina):

**Link do kalendarza (skopiuj):**
`https://raw.githubusercontent.com/szemkhel/volley-bot/calendar/calendar.ics`

- **Google Calendar — najszybciej:** otwórz [stronę „Dodaj przez URL"](https://calendar.google.com/calendar/u/0/r/settings/addbyurl), wklej powyższy link i kliknij *Dodaj kalendarz*. (Na telefonie z Androidem pojawi się automatycznie po dodaniu na koncie Google.)
- **iPhone:** Ustawienia → Kalendarz → Konta → Dodaj konto → Inne → *Dodaj subskrybowany kalendarz* → wklej link

> Aplikacje odświeżają subskrybowany kalendarz co kilka godzin, więc zmiana terminu pojawia się z lekkim opóźnieniem.

## 💬 Komendy

Wszystkie komendy piszesz **na grupie**, zaczynając od słowa **`bot`**.

### Ankieta i głosowanie
- `bot ankieta piątek 20:00` — tworzy nową ankietę na trening. Opcje: **Gram**, **Nie gram**, **Nie wiem**, **Gram i przyprowadzam +1**, **Gram i przyprowadzam +2**
- `bot status` — liczba graczy na najbliższy trening
- `bot przypomnij` — wysyła przypomnienie do osób, które jeszcze nie zagłosowały. Gdy do gry
  zostały maksymalnie 2 dni, działa jak ostatnie wołanie: dopytuje też osoby z głosem „Nie wiem"
- `bot przypominajki` — (admin) lista nadchodzących, zaplanowanych przypomnień dla gier w tym tygodniu
- `bot kontuzja <czas>` — zgłoś dłuższą przerwę (np. `bot kontuzja 2 tygodnie`, `bot kontuzja miesiąc`); bot pomija Cię w przypomnieniach do końca przerwy. Powrót: `bot kontuzja koniec`. Admin może zgłosić za kogoś: `bot kontuzja @osoba 3 tygodnie`

### Zmiany terminu
- `bot zmień dzień na czwartek` — zmienia dzień treningu
- `bot zmień godzinę 21:00` — zmienia godzinę
- `bot gramy w czwartek` — ustawia dzień gry
- `bot nie gramy` — odwołuje trening w tym tygodniu
- `bot cofnij odwołanie` — przywraca odwołany trening

### Statystyki
- `bot imie @osoba Imię S.` — poprawia czyjeś imię w statystykach i na panelu (admin). Konwencja:
  imię + co najwyżej krótki inicjał nazwiska (np. „S." albo „Sz"), nigdy pełne nazwisko — jeśli
  bot wykryje pełne nazwisko, dopyta „tak/nie", zanim je zapisze
- `bot frekwencja` — ostatnie 10 ankiet (data, liczba graczy, grane/odwołane)
- `bot ranking` — ranking obecności graczy (kto gra najczęściej)

📊 **Publiczny panel ze statystykami** (ranking, frekwencja, statystyki graczy) jest pod adresem
[siatkowka.agatrymki.net](https://siatkowka.agatrymki.net/public-dashboards/04eb09a0ce994c36851e51d5e877f1b4) —
link pojawia się też pod odpowiedziami na `bot ranking` / `bot frekwencja` / `bot statystyki`.

### Rozliczenie sali
- `bot rozlicz` — bot zapyta o koszt sali i liczbę graczy, podzieli koszt i wskaże komu ile zapłacić (osoby z +1/+2 płacą za gości), z numerem BLIK
- `bot rozlicz 100 10` — to samo, ale od razu z danymi (100 zł, 10 osób)
- `bot koszt sali` — pokazuje zapisany koszt wynajmu; `bot koszt sali 200` ustawia go (admin)
- Nie musisz używać komend: jeśli ktoś wrzuci na grupę zwykłą wiadomość z podziałem kosztu
  („po 14,55 zł, BLIK…”), bot sam ją rozpozna i zapisze realną liczbę graczy. Właśnie do tego
  służy zapisany koszt sali — gdy w wiadomości jest tylko kwota na osobę, bez sumy, bot liczy
  graczy jako *koszt sali ÷ kwota na osobę*, więc nieaktualna wartość da cichy błąd we frekwencji
- Po zamknięciu rozliczenia bot proponuje głosowanie MVP i pokazuje listę kandydatów (osoby, które
  zadeklarowały grę). Odpowiedz `tak`, żeby je wystawić, albo `nie`. Efekt jest identyczny jak przy
  `bot mvp` — to ta sama ankieta

### Głosowanie MVP
- `bot mvp` — wystawia ankietę „MVP tygodnia” z graczami ostatniego meczu (admin). Zamyka się
  automatycznie po 24 h, a zwycięzca dostaje gratulacje i trafia do panelu ze statystykami
- Ankieta WhatsAppa mieści **maksymalnie 12 opcji** — to ograniczenie platformy, nie bota. Gdy
  zagrało więcej osób, bot wybiera 12 graczy z najwyższą frekwencją w sezonie i wysyła
  organizatorowi prywatną wiadomość z listą tych, którzy się nie zmieścili
- Bot sam zaproponuje to głosowanie po każdym rozliczeniu, więc zwykle nie musisz o nim pamiętać

### Inne
- `bot pomoc` — pełna lista komend

## 🤖 Co bot robi automatycznie
- **Poniedziałek 10:00** — wystawia ankietę na najbliższy trening (domyślnie piątek 20:00).
  Jeśli WhatsApp w tym momencie nie odpowiada, bot ponawia próby i sprawdza co godzinę do 20:00,
  więc chwilowa awaria łącza nie kosztuje całego tygodnia
- **Przypomnienia** — wtorek 18:00 (pierwsze) i środa 17:00 (ostatnie) dla piątkowego treningu;
  terminy przesuwają się, gdy gramy w inny dzień. Pierwsze zagaduje tych, którzy jeszcze nie
  zagłosowali. **Ostatnie dodatkowo dopytuje osoby z „Nie wiem"** — to już ostatni dzień na
  odwołanie sali, więc niezdecydowany głos nie pomaga bardziej niż brak głosu
- Bot oznacza (@) tylko osoby **aktualnie należące do grupy** — skład sprawdza na żywo przed
  każdym przypomnieniem, rozliczeniem i ogłoszeniem MVP, żeby nie zostawiać martwych oznaczeń
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

### Monitoring stanu (`/health`)

Bot wystawia swój stan pod `GET :3000/health` (ten sam serwer, co feed kalendarza) — na
użytek zewnętrznego monitoringu:

| odpowiedź | znaczenie |
|---|---|
| `200` | zdrowy |
| `503` | połączenie z WhatsAppem leży dłużej niż 15 min, albo wymagane ponowne parowanie (`needsRepair`) |
| brak odpowiedzi | proces martwy lub zawieszony |

```json
{ "status": "ok", "connected": true, "downForSec": 0, "uptimeSec": 12345,
  "lastOpenAt": "…", "lastCloseAt": null, "lastCloseCode": null,
  "lastMessageAt": "…", "needsRepair": false, "openPolls": 1, "version": "v1.23" }
```

Stan liczony jest z **socketu WhatsAppa**, nie z procesu: usługa potrafi raportować `active`,
mając martwe połączenie — tak przepadły trzy dni w lipcu 2026. `needsRepair: true` oznacza,
że restart nie pomoże i potrzebna jest ręczna interwencja.

### Stos technologiczny
- Node.js + [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web) — wersja klienta
  WA pobierana przy starcie, bo WhatsApp odrzuca wycofane wersje błędem `405`
- Claude (Anthropic) — generowanie wiadomości po polsku
- node-cron — harmonogram zadań
