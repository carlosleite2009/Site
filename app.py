import os, sqlite3, uuid, secrets, json
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, g, jsonify, request, session, send_from_directory, redirect, abort
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, 'dados.db')
UP = os.path.join(BASE, 'uploads')
os.makedirs(UP, exist_ok=True)

MAX_CONTAS = 3
MODO_DEMO = os.environ.get('MODO_DEMO', '1') == '1'   # permite "simular validação"
PRIORIDADES = ['Não definida', 'Urgente', 'Alta', 'Média', 'Baixa']
SITUACOES = ['Recebida', 'Em análise', 'Em andamento', 'Resolvida', 'Não resolvida', 'Arquivada']
PROTEGIDAS = {'painel', 'mapa', 'ocorrencias', 'gestao', 'relatorios', 'comunicados'}

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'troque-esta-chave-em-producao')
app.config['MAX_CONTENT_LENGTH'] = 25 * 1024 * 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS contas (id INTEGER PRIMARY KEY AUTOINCREMENT, escola TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE, responsavel TEXT NOT NULL, senha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente', criada TEXT);
CREATE TABLE IF NOT EXISTS ocorrencias (protocolo TEXT PRIMARY KEY, local TEXT, categoria TEXT, titulo TEXT,
  descricao TEXT, anexos TEXT DEFAULT '[]', criada TEXT, prioridade TEXT DEFAULT 'Não definida',
  situacao TEXT DEFAULT 'Recebida', justificativa TEXT);
CREATE TABLE IF NOT EXISTS historico (id INTEGER PRIMARY KEY AUTOINCREMENT, protocolo TEXT, data TEXT, texto TEXT);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, setor TEXT, acao TEXT);
CREATE TABLE IF NOT EXISTS comunicados (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT, mensagem TEXT,
  data TEXT, arquivado INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS recuperacao (token TEXT PRIMARY KEY, email TEXT, validade TEXT, usado INTEGER DEFAULT 0);
"""


def db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def fechar(_):
    d = g.pop('db', None)
    if d:
        d.close()


def q(sql, args=(), um=False):
    cur = db().execute(sql, args)
    rows = cur.fetchall()
    db().commit()
    return (rows[0] if rows else None) if um else rows


def agora():
    return datetime.now().isoformat(timespec='seconds')


def log(setor, acao):
    q('INSERT INTO logs(data,setor,acao) VALUES(?,?,?)', (agora(), setor, acao))


def iniciar():
    c = sqlite3.connect(DB)
    c.executescript(SCHEMA)
    if not c.execute("SELECT 1 FROM contas WHERE email='teste.escola@gmail.com'").fetchone():
        c.execute("INSERT INTO contas(escola,email,responsavel,senha,status,criada) VALUES(?,?,?,?,?,?)",
                  ('Escola de Demonstração', 'teste.escola@gmail.com', 'Usuário de teste',
                   generate_password_hash('Escola12345'), 'aprovada', agora()))
    c.commit()
    c.close()


def login_obrigatorio(f):
    @wraps(f)
    def w(*a, **k):
        if 'email' not in session:
            return jsonify(erro='Faça login primeiro.'), 401
        return f(*a, **k)
    return w


def ocorrencia(r):
    d = dict(r)
    d['anexos'] = json.loads(d['anexos'] or '[]')
    return d


# ---------- páginas ----------
@app.route('/')
def raiz():
    return redirect('/index2.html')


@app.route('/<nome>.html')
def pagina(nome):
    if nome in PROTEGIDAS and 'email' not in session:
        return redirect('/index2.html')
    if not os.path.exists(os.path.join(BASE, 'paginas', nome + '.html')):
        abort(404)
    return send_from_directory(os.path.join(BASE, 'paginas'), nome + '.html')


@app.route('/uploads/<path:arq>')
@login_obrigatorio
def baixar(arq):
    return send_from_directory(UP, arq)


# ---------- conta institucional ----------
@app.route('/api/registro', methods=['POST'])
def registro():
    d = request.get_json(silent=True) or {}
    escola, email = d.get('school', '').strip(), d.get('email', '').strip().lower()
    dono, senha = d.get('owner', '').strip(), d.get('password', '')
    if not all([escola, email, dono, senha]):
        return jsonify(erro='Preencha todos os campos.'), 400
    if len(senha) < 8:
        return jsonify(erro='A senha precisa ter pelo menos 8 caracteres.'), 400
    if senha != d.get('confirm'):
        return jsonify(erro='As senhas não correspondem.'), 400
    if q('SELECT COUNT(*) n FROM contas', um=True)['n'] >= MAX_CONTAS:
        return jsonify(erro='Limite atingido: o sistema permite no máximo 3 contas.'), 409
    if q('SELECT 1 FROM contas WHERE email=?', (email,), um=True):
        return jsonify(erro='Este e-mail já está cadastrado.'), 409
    q('INSERT INTO contas(escola,email,responsavel,senha,criada) VALUES(?,?,?,?,?)',
      (escola, email, dono, generate_password_hash(senha), agora()))
    log('Configuração inicial', f'Cadastro institucional enviado para validação: {email}')
    return jsonify(mensagem='Cadastro enviado para validação institucional.'), 201


@app.route('/api/login', methods=['POST'])
def login():
    d = request.get_json(silent=True) or {}
    email, senha = d.get('email', '').strip().lower(), d.get('senha', '')
    c = q('SELECT * FROM contas WHERE email=?', (email,), um=True)
    if not c or not check_password_hash(c['senha'], senha):
        return jsonify(erro='E-mail ou senha incorretos.'), 401
    if c['status'] != 'aprovada':
        return jsonify(erro='Cadastro aguardando validação institucional. O acesso ainda não foi liberado.'), 403
    session['email'] = c['email']
    log('Acesso institucional', f'Login realizado: {email}')
    return jsonify(mensagem='ok')


@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify(mensagem='ok')


@app.route('/api/me')
@login_obrigatorio
def me():
    c = q('SELECT escola,email,status FROM contas WHERE email=?', (session['email'],), um=True)
    return jsonify(dict(c))


@app.route('/api/recuperar', methods=['POST'])
def recuperar():
    email = (request.get_json(silent=True) or {}).get('email', '').strip().lower()
    if q('SELECT 1 FROM contas WHERE email=?', (email,), um=True):
        t = secrets.token_urlsafe(24)
        q('INSERT INTO recuperacao VALUES(?,?,?,0)', (t, email, (datetime.now() + timedelta(minutes=15)).isoformat()))
        print(f'\n[RECUPERAÇÃO DE SENHA] {email}: {request.host_url}redefinir.html?token={t}\n', flush=True)
    return jsonify(mensagem='Se o e-mail estiver cadastrado, o link de redefinição foi gerado (válido por 15 minutos).')


@app.route('/api/redefinir', methods=['POST'])
def redefinir():
    d = request.get_json(silent=True) or {}
    r = q('SELECT * FROM recuperacao WHERE token=? AND usado=0', (d.get('token', ''),), um=True)
    if not r or datetime.fromisoformat(r['validade']) < datetime.now():
        return jsonify(erro='Link inválido ou expirado.'), 400
    if len(d.get('senha', '')) < 8:
        return jsonify(erro='A senha precisa ter pelo menos 8 caracteres.'), 400
    q('UPDATE contas SET senha=? WHERE email=?', (generate_password_hash(d['senha']), r['email']))
    q('UPDATE recuperacao SET usado=1 WHERE token=?', (r['token'],))
    log('Acesso institucional', f"Senha redefinida: {r['email']}")
    return jsonify(mensagem='Senha alterada! Já pode entrar no sistema.')


@app.route('/api/pendentes')
def pendentes():
    if not MODO_DEMO:
        return jsonify([])
    return jsonify([dict(r) for r in q("SELECT escola,email FROM contas WHERE status='pendente'")])


@app.route('/api/aprovar', methods=['POST'])
def aprovar():
    if not MODO_DEMO:
        return jsonify(erro='Validação simulada desativada.'), 403
    email = (request.get_json(silent=True) or {}).get('email') or session.get('email', '')
    q("UPDATE contas SET status='aprovada' WHERE email=?", (email,))
    log('Validação institucional (demonstração)', f'Cadastro aprovado para teste: {email}')
    return jsonify(mensagem='Aprovado.')


# ---------- painel ----------
@app.route('/api/painel')
@login_obrigatorio
def painel():
    n = lambda w: q(f'SELECT COUNT(*) n FROM ocorrencias {w}', um=True)['n']
    return jsonify(
        total=n(''), pendentes=n("WHERE situacao IN ('Recebida','Em análise')"),
        andamento=n("WHERE situacao='Em andamento'"), resolvidas=n("WHERE situacao='Resolvida'"),
        atividades=[dict(r) for r in q('SELECT data,setor,acao FROM logs ORDER BY id DESC LIMIT 12')])


@app.route('/api/logs')
@login_obrigatorio
def logs():
    return jsonify([dict(r) for r in q('SELECT data,setor,acao FROM logs ORDER BY id DESC LIMIT 300')])


# ---------- ocorrências ----------
@app.route('/api/ocorrencias', methods=['GET'])
@login_obrigatorio
def listar():
    return jsonify([ocorrencia(r) for r in q('SELECT * FROM ocorrencias ORDER BY criada DESC')])


@app.route('/api/ocorrencias', methods=['POST'])
@login_obrigatorio
def criar():
    f = request.form
    campos = [f.get(k, '').strip() for k in ('local', 'categoria', 'titulo', 'descricao')]
    if not all(campos):
        return jsonify(erro='Preencha todos os campos obrigatórios.'), 400
    anexos = []
    for arq in request.files.getlist('anexos'):
        if arq.filename:
            nome = f'{uuid.uuid4().hex[:10]}_{secure_filename(arq.filename) or "arquivo"}'
            arq.save(os.path.join(UP, nome))
            anexos.append({'nome': arq.filename, 'arquivo': nome})
    prot = 'OCO-' + uuid.uuid4().hex[:6].upper()
    q('INSERT INTO ocorrencias(protocolo,local,categoria,titulo,descricao,anexos,criada) VALUES(?,?,?,?,?,?,?)',
      (prot, *campos, json.dumps(anexos), agora()))
    log('Secretaria', f'Registrou e encaminhou a ocorrência {prot} ({campos[0]})')
    return jsonify(protocolo=prot), 201


@app.route('/api/ocorrencias/<prot>', methods=['PUT'])
@login_obrigatorio
def atualizar(prot):
    d = request.get_json(silent=True) or {}
    o = q('SELECT * FROM ocorrencias WHERE protocolo=?', (prot,), um=True)
    if not o:
        return jsonify(erro='Ocorrência não encontrada.'), 404
    p, s = d.get('prioridade', o['prioridade']), d.get('situacao', o['situacao'])
    prov, just = (d.get('providencias') or '').strip(), (d.get('justificativa') or '').strip()
    if p not in PRIORIDADES or s not in SITUACOES:
        return jsonify(erro='Prioridade ou situação inválida.'), 400
    if s == 'Não resolvida' and not (just or o['justificativa']):
        return jsonify(erro='Informe a justificativa para uma ocorrência não resolvida.'), 400
    if not prov and not just and p == o['prioridade'] and s == o['situacao']:
        return jsonify(erro='Faça alguma alteração antes de salvar.'), 400
    q('UPDATE ocorrencias SET prioridade=?,situacao=?,justificativa=? WHERE protocolo=?',
      (p, s, just or o['justificativa'], prot))
    texto = f"Prioridade: {p}; situação: {s}" + (f'; providências: {prov}' if prov else '') + (f'; justificativa: {just}' if just else '')
    q('INSERT INTO historico(protocolo,data,texto) VALUES(?,?,?)', (prot, agora(), texto))
    log('Gestão', f'Atualizou {prot}: {s}, prioridade {p}')
    return jsonify(mensagem='Atualizada.')


@app.route('/api/ocorrencias/<prot>/historico')
@login_obrigatorio
def historico(prot):
    return jsonify([dict(r) for r in q('SELECT data,texto FROM historico WHERE protocolo=? ORDER BY id DESC', (prot,))])


# ---------- comunicados ----------
@app.route('/api/comunicados', methods=['GET'])
@login_obrigatorio
def com_listar():
    return jsonify([dict(r) for r in q('SELECT * FROM comunicados ORDER BY id DESC')])


@app.route('/api/comunicados', methods=['POST'])
@login_obrigatorio
def com_criar():
    d = request.get_json(silent=True) or {}
    t, m = (d.get('titulo') or '').strip(), (d.get('mensagem') or '').strip()
    if not t or not m:
        return jsonify(erro='Informe título e mensagem.'), 400
    q('INSERT INTO comunicados(titulo,mensagem,data) VALUES(?,?,?)', (t, m, agora()))
    log('Gestão', f'Publicou comunicado: {t}')
    return jsonify(mensagem='Publicado.'), 201


@app.route('/api/comunicados/<int:i>', methods=['PUT'])
@login_obrigatorio
def com_editar(i):
    d = request.get_json(silent=True) or {}
    t, m = (d.get('titulo') or '').strip(), (d.get('mensagem') or '').strip()
    if not t or not m:
        return jsonify(erro='Informe título e mensagem.'), 400
    q('UPDATE comunicados SET titulo=?,mensagem=? WHERE id=? AND arquivado=0', (t, m, i))
    log('Gestão', f'Editou comunicado: {t}')
    return jsonify(mensagem='Atualizado.')


@app.route('/api/comunicados/<int:i>/arquivar', methods=['POST'])
@login_obrigatorio
def com_arquivar(i):
    q('UPDATE comunicados SET arquivado=1 WHERE id=?', (i,))
    log('Gestão', f'Arquivou comunicado #{i}')
    return jsonify(mensagem='Arquivado.')


iniciar()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=False)
