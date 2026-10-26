# Rebuilds packages/backend/src/verify/recordings/sites.json from real Lichess games (CC0).
# Usage: python3 -I data-prep/build-site-recordings.py packages/shared/test/fixtures/lichess-games.pgn packages/backend/src/verify/recordings/sites.json
# Builds the recorded Lichess and chess.com responses from real CC0 Lichess games.
import json, re, sys
src, out = sys.argv[1], sys.argv[2]
games = ['[Event' + g if not g.startswith('[Event') else g for g in open(src).read().strip().split('\n\n[Event')]
def header(pgn, key):
    m = re.search(r'^\[%s "(.*)"\]$' % key, pgn, re.M); return m.group(1) if m else ''
def set_header(pgn, key, value):
    return re.sub(r'^\[%s ".*"\]$' % key, '[%s "%s"]' % (key, value), pgn, flags=re.M)
def strip_tail(pgn):
    head, moves = pgn.split('\n\n', 1)
    toks = moves.split()
    toks = toks[:-1]  # drop result
    toks = toks[:20]
    head = set_header(set_header(head, 'Result', '*'), 'Termination', 'Unterminated')
    head = re.sub(r'^\[(White|Black)RatingDiff .*\n', '', head, flags=re.M)
    return head + '\n\n' + ' '.join(toks) + ' *\n'
rec = {}
L = 'https://lichess.org'
C = 'https://api.chess.com'
# Lichess: CoachVerify plays White in games 0 and 1, Black in game 2; game 3 is still being played.
lines = []
for i, (g, side) in enumerate([(games[0], 'White'), (games[1], 'White'), (games[2], 'Black')]):
    pgn = set_header(g, side, 'CoachVerify')
    gid = header(g, 'Site').rsplit('/', 1)[1]
    pgn = set_header(pgn, 'Site', f'https://lichess.org/{gid}')
    status = 'resign' if i != 1 else 'mate'
    lines.append({'id': gid, 'rated': True, 'variant': 'standard', 'speed': 'rapid', 'perf': 'rapid', 'status': status,
                  'winner': 'white' if header(g,'Result') == '1-0' else 'black', 'pgn': pgn})
live = set_header(strip_tail(games[3]), 'White', 'CoachVerify')
lines.insert(0, {'id': 'livegame1', 'rated': True, 'variant': 'standard', 'speed': 'rapid', 'perf': 'rapid', 'status': 'started', 'pgn': set_header(live, 'Site', 'https://lichess.org/livegame1')})
rec[f'{L}/api/user/CoachVerify'] = {'status': 200, 'body': {'id': 'coachverify', 'username': 'CoachVerify', 'perfs': {'bullet': {'games': 0, 'rating': 1500}, 'rapid': {'games': 212, 'rating': 1612}, 'classical': {'games': 3, 'rating': 1700}}}}
rec[f'{L}/api/games/user/CoachVerify'] = {'status': 200, 'contentType': 'application/x-ndjson', 'body': '\n'.join(json.dumps(x) for x in lines) + '\n'}
rec[f'{L}/api/user/NoSuchPlayer'] = {'status': 404, 'body': {'error': 'Not found'}}
rec[f'{L}/api/games/user/NoSuchPlayer'] = {'status': 404, 'body': {'error': 'Not found'}}
rec[f'{L}/api/user/BusyPlayer'] = {'status': 429, 'body': {'error': 'Too many requests'}}
rec[f'{L}/api/games/user/BusyPlayer'] = {'status': 429, 'body': {'error': 'Too many requests'}}
# chess.com: two monthly archives; the newest has an unfinished game.
cg = []
for i, (g, side) in enumerate([(games[4], 'White'), (games[5], 'Black'), (games[6], 'White')]):
    pgn = set_header(g, side, 'coachverify')
    cg.append({'url': f'https://www.chess.com/game/live/9000000{i}', 'uuid': f'00000000-0000-4000-8000-00000000000{i}', 'pgn': pgn,
               'rules': 'chess', 'time_class': 'rapid', 'end_time': 1790000000 + i * 1000})
unfinished = set_header(strip_tail(games[7]), 'White', 'coachverify')
rec[f'{C}/pub/player/coachverify/stats'] = {'status': 200, 'body': {'chess_rapid': {'last': {'rating': 1488, 'date': 1790000000}}, 'chess_blitz': {'last': {'rating': 1390}}}}
rec[f'{C}/pub/player/coachverify/games/archives'] = {'status': 200, 'body': {'archives': [f'{C}/pub/player/coachverify/games/2026/09', f'{C}/pub/player/coachverify/games/2026/10']}}
rec[f'{C}/pub/player/coachverify/games/2026/09'] = {'status': 200, 'body': {'games': cg[:2]}}
rec[f'{C}/pub/player/coachverify/games/2026/10'] = {'status': 200, 'body': {'games': [cg[2], {'url': 'https://www.chess.com/game/daily/90000099', 'uuid': '00000000-0000-4000-8000-000000000099', 'pgn': unfinished, 'rules': 'chess', 'time_class': 'daily'}]}}
rec[f'{C}/pub/player/nosuchplayer/stats'] = {'status': 404, 'body': {'code': 0, 'message': 'User "nosuchplayer" not found.'}}
rec[f'{C}/pub/player/nosuchplayer/games/archives'] = {'status': 404, 'body': {'code': 0, 'message': 'User "nosuchplayer" not found.'}}
json.dump({'note': 'Recorded in the documented response formats of the Lichess API and the chess.com published-data API, built from real games of the Lichess database (CC0) with the Player renamed CoachVerify. Used by verify mode and the tests; nothing here reaches the network.', 'responses': rec}, open(out, 'w'), indent=1)
print(len(rec))
