import os
import json
import time
from queue import Queue, Empty
from datetime import datetime, time as dtime, timedelta, timezone
from typing import List, Dict, Any
from zoneinfo import ZoneInfo

from flask import Flask, render_template, request, redirect, url_for, jsonify, Response, stream_with_context

# Socket.IO disabled for this build
SocketIO = None  # Explicitly disable sockets

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CONFIG_FILE = os.path.join(DATA_DIR, 'config.json')

# Flask app
app = Flask(__name__, static_folder='static', template_folder='templates')
app.secret_key = os.environ.get('FLASK_SECRET', 'dev-secret')

# No Socket.IO in this build
socketio = None

# Defaults
DEFAULT_CONFIG: Dict[str, Any] = {
    "theme": "fire",
    "timezone": "UTC",
    "schedule": [
        {
            "label": "Period 1",
            "days": ["Mon", "Tue", "Wed", "Thu", "Fri"],
            "start": "09:00",
            "end": "09:50"
        },
        {
            "label": "Break",
            "days": ["Mon", "Tue", "Wed", "Thu", "Fri"],
            "start": "09:50",
            "end": "10:00"
        }
    ]
}

DAYS_IDX: List[str] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def ensure_data_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)


def load_config() -> Dict[str, Any]:
    ensure_data_dir()
    if not os.path.isfile(CONFIG_FILE):
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        # If corrupt, reset to default to keep app running
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG


def save_config(cfg: Dict[str, Any]) -> None:
    ensure_data_dir()
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def parse_hhmm(s: str) -> dtime:
    parts = s.split(':')
    return dtime(int(parts[0]), int(parts[1]), 0)


def compute_now() -> Dict[str, Any]:
    cfg = load_config()
    theme = cfg.get('theme', 'fire')
    schedule = cfg.get('schedule', [])
    tz_name = cfg.get('timezone', 'UTC')
    # Robust timezone handling: prefer built-in UTC on Windows when tzdata may be missing
    aliases_utc = {'UTC', 'Z', 'GMT', 'ETC/UTC'}
    if str(tz_name).upper() in aliases_utc:
        tz = timezone.utc
    else:
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = timezone.utc

    now = datetime.now(tz)
    dow_idx = now.weekday()  # 0=Mon
    dow_name = DAYS_IDX[dow_idx]

    def norm_days(obj) -> List[str]:
        if not obj:
            return DAYS_IDX
        if isinstance(obj, str):
            ds = obj.strip()
            if ds.lower() == 'all':
                return DAYS_IDX
            return [ds[:3].title()]
        out: List[str] = []
        for d in obj:
            if isinstance(d, int):
                if 0 <= d <= 6:
                    out.append(DAYS_IDX[d])
            elif isinstance(d, str):
                out.append(d[:3].title())
        return out or DAYS_IDX

    # Build today's events
    today_events: List[Dict[str, Any]] = []
    for ev in schedule:
        days_list = norm_days(ev.get('days') or ev.get('day') or ev.get('dow'))
        if dow_name not in days_list:
            continue
        try:
            start_t = parse_hhmm(ev['start'])
            end_t = parse_hhmm(ev['end'])
        except Exception:
            continue
        start_dt = datetime.combine(now.date(), start_t).replace(tzinfo=tz)
        end_dt = datetime.combine(now.date(), end_t).replace(tzinfo=tz)
        # allow events that cross midnight
        if end_dt <= start_dt:
            end_dt += timedelta(days=1)
        today_events.append({
            'label': ev.get('label', 'Class'),
            'start_dt': start_dt,
            'end_dt': end_dt
        })

    # Sort by start
    today_events.sort(key=lambda e: e['start_dt'])

    status = 'idle'
    current = None
    next_ev = None
    for ev in today_events:
        if ev['start_dt'] <= now < ev['end_dt']:
            current = ev
            status = 'in_session'
            break
        if now < ev['start_dt'] and next_ev is None:
            next_ev = ev

    # If no upcoming today, look ahead to next matching day
    if not current and next_ev is None:
        best_next = None
        for delta in range(1, 8):
            d = now.date() + timedelta(days=delta)
            dow2 = DAYS_IDX[(dow_idx + delta) % 7]
            for ev in schedule:
                days_list = norm_days(ev.get('days') or ev.get('day') or ev.get('dow'))
                if dow2 not in days_list:
                    continue
                try:
                    start_t = parse_hhmm(ev['start'])
                    end_t = parse_hhmm(ev['end'])
                except Exception:
                    continue
                start_dt = datetime.combine(d, start_t).replace(tzinfo=tz)
                end_dt = datetime.combine(d, end_t).replace(tzinfo=tz)
                if end_dt <= start_dt:
                    end_dt += timedelta(days=1)
                cand = {
                    'label': ev.get('label', 'Class'),
                    'start_dt': start_dt,
                    'end_dt': end_dt
                }
                if best_next is None or start_dt < best_next['start_dt']:
                    best_next = cand
            if best_next is not None:
                break
        next_ev = best_next

    if current:
        remaining = int((current['end_dt'] - now).total_seconds())
        label = current['label']
        ends_at = current['end_dt'].strftime('%H:%M')
    elif next_ev:
        status = 'pre_session'
        remaining = int((next_ev['start_dt'] - now).total_seconds())
        label = next_ev['label']
        ends_at = None
    else:
        remaining = 0
        label = 'Idle'
        ends_at = None

    payload = {
        'server_time_iso': now.isoformat(),
        'status': status,
        'remaining_seconds': max(0, remaining),
        'current_label': label,
        'ends_at': ends_at,
        'next_start': next_ev['start_dt'].strftime('%H:%M') if next_ev else None,
        'next_label': next_ev['label'] if next_ev else None,
        'theme': theme,
    }
    return payload


@app.route('/')
def index():
    return redirect(url_for('display'))


@app.route('/display')
def display():
    cfg = load_config()
    return render_template('display.html', theme=cfg.get('theme', 'fire'))


@app.route('/control', methods=['GET', 'POST'])
def control():
    cfg = load_config()
    message = None
    error = None
    if request.method == 'POST':
        theme = request.form.get('theme') or cfg.get('theme', 'fire')
        schedule_text = request.form.get('schedule_json') or ''
        try:
            parsed = json.loads(schedule_text) if schedule_text.strip() else cfg.get('schedule', [])
            if not isinstance(parsed, list):
                raise ValueError('Schedule must be a JSON array')
            cfg['schedule'] = parsed
            cfg['theme'] = theme
            save_config(cfg)
            # Notify displays via SSE
            try:
                publish_event('config', { 'theme': cfg.get('theme'), 'schedule': cfg.get('schedule'), 'server_time_iso': datetime.now().isoformat() })
                # Also push a fresh snapshot of current time state
                publish_event('snapshot', compute_now())
            except Exception:
                pass
            message = 'Saved successfully.'
        except Exception as e:
            error = f'Invalid JSON: {e}'
    # Prepare pretty JSON string
    schedule_str = json.dumps(cfg.get('schedule', []), ensure_ascii=False, indent=2)
    return render_template('control.html', schedule_json=schedule_str, theme=cfg.get('theme', 'fire'), message=message, error=error)


@app.route('/api/schedule', methods=['GET', 'POST'])
def api_schedule():
    if request.method == 'GET':
        return jsonify(load_config())
    data = request.get_json(silent=True) or {}
    cfg = load_config()
    if 'schedule' in data:
        if not isinstance(data['schedule'], list):
            return jsonify({'ok': False, 'error': 'schedule must be a list'}), 400
        cfg['schedule'] = data['schedule']
    if 'theme' in data:
        cfg['theme'] = data['theme']
    if 'timezone' in data:
        cfg['timezone'] = data['timezone']
    save_config(cfg)
    # publish config update for displays
    try:
        publish_event('config', { 'theme': cfg.get('theme'), 'schedule': cfg.get('schedule'), 'server_time_iso': datetime.now().isoformat() })
    except Exception:
        pass
    return jsonify({'ok': True})


@app.route('/now')
def now_route():
    return jsonify(compute_now())


# --- Simple Server-Sent Events (SSE) implementation ---
SUBSCRIBERS: List[Queue] = []

def publish_event(event: str, data: Dict[str, Any]) -> None:
    payload = json.dumps({'event': event, 'data': data})
    dead = []
    for q in list(SUBSCRIBERS):
        try:
            q.put_nowait(payload)
        except Exception:
            dead.append(q)
    for q in dead:
        try:
            SUBSCRIBERS.remove(q)
        except ValueError:
            pass


@app.route('/events')
def sse_events():
    def event_stream():
        q: Queue = Queue()
        SUBSCRIBERS.append(q)
        try:
            # initial snapshot
            initial = json.dumps({'event': 'snapshot', 'data': compute_now()})
            yield f"data: {initial}\n\n"
            while True:
                try:
                    msg = q.get(timeout=15)
                    yield f"data: {msg}\n\n"
                except Empty:
                    # heartbeat to keep connection alive
                    yield ":keepalive\n\n"
        finally:
            try:
                SUBSCRIBERS.remove(q)
            except ValueError:
                pass
    headers = {'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
    return Response(stream_with_context(event_stream()), mimetype='text/event-stream', headers=headers)


@app.route('/api/push', methods=['POST'])
def api_push():
    data = request.get_json(silent=True) or {}
    event = data.get('event') or data.get('type') or 'message'
    payload = data.get('data')
    if payload is None:
        payload = {k: v for k, v in data.items() if k not in ('event', 'type')}
    publish_event(event, payload)
    return jsonify({'ok': True})


if __name__ == '__main__':
    host = os.environ.get('HOST', '0.0.0.0')
    port = int(os.environ.get('PORT', '5000'))
    app.run(host=host, port=port)
