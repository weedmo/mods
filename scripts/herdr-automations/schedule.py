"""Small explicit calendar schedules. UTC instants, IANA local wall clocks."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

KINDS = ('hourly', 'daily', 'weekdays', 'weekly')

def validate(value):
    if not isinstance(value, dict) or value.get('kind') not in KINDS:
        raise ValueError('예약은 hourly/daily/weekdays/weekly 중 하나여야 합니다.')
    zone = value.get('timezone', 'Asia/Seoul')
    try:
        ZoneInfo(zone)
    except (KeyError, TypeError, ValueError):
        raise ValueError('유효한 IANA 시간대가 필요합니다 (예: Asia/Seoul).')
    result = {'kind': value['kind'], 'timezone': zone}
    for key, default, maximum in [('hour', 9, 23), ('minute', 0, 59), ('weekday', 0, 6)]:
        n = value.get(key, default)
        if type(n) is not int or not 0 <= n <= maximum:
            raise ValueError(f'{key}: 0~{maximum} 정수를 입력하세요.')
        result[key] = n
    return result

def occurrences(schedule, after, count=1):
    """Strictly after epoch seconds. Skip DST gaps; use first fold only."""
    s = validate(schedule)
    z = ZoneInfo(s['timezone'])
    day = datetime.fromtimestamp(after, z).date()
    found = []
    for offset in range(370):
        date = day + timedelta(days=offset)
        if s['kind'] == 'weekdays' and date.weekday() > 4:
            continue
        if s['kind'] == 'weekly' and date.weekday() != s['weekday']:
            continue
        hours = range(24) if s['kind'] == 'hourly' else [s['hour']]
        for hour in hours:
            naive = datetime(date.year, date.month, date.day, hour, s['minute'])
            candidate = naive.replace(tzinfo=z, fold=0)
            instant = candidate.timestamp()
            if datetime.fromtimestamp(instant, z).replace(tzinfo=None) != naive:
                continue
            if instant > after:
                found.append(instant)
                if len(found) == count:
                    return found
    raise ValueError('예약 시각을 계산할 수 없습니다.')

def latest(schedule, now):
    # Every supported preset occurs at least weekly; bounded even after years offline.
    start = now - 9 * 86400
    result = None
    for instant in occurrences(schedule, start, 240 if schedule['kind'] == 'hourly' else 10):
        if instant > now:
            break
        result = instant
    return result
