const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = d => new Date(d).toLocaleString('pt-BR');
const cls = p => ({'Urgente':'urgente','Alta':'alta','Média':'media','Baixa':'baixa','Resolvida':'resolvida'}[p] || '');
const badge = t => `<span class="badge ${cls(t)}">${esc(t)}</span>`;
const PRIOR = ['Não definida', 'Urgente', 'Alta', 'Média', 'Baixa'];
const SIT = ['Recebida', 'Em análise', 'Em andamento', 'Resolvida', 'Não resolvida', 'Arquivada'];

async function api(url, opt = {}) {
    const r = await fetch(url, {credentials: 'same-origin', ...opt});
    let d = {};
    try { d = await r.json(); } catch {}
    if (r.status === 401 && !url.includes('/login')) { location.href = '/index2.html'; throw new Error('sessão'); }
    if (!r.ok) throw new Error(d.erro || 'Erro ao comunicar com o servidor.');
    return d;
}
const send = (m, url, body) => api(url, {method: m, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
async function logout() { await send('POST', '/api/logout'); location.href = '/index2.html'; }
const msg = (id, t, ok) => { const e = $(id); if (e) { e.textContent = t; e.style.color = ok ? '#16833b' : '#c0392b'; } };

const paginas = {
    'index2.html'() {
        $('fillDemo').onclick = () => {
            $('email').value = 'teste.escola@gmail.com'; $('senha').value = 'Escola12345';
            msg('loginMsg', 'Dados de demonstração preenchidos. Clique em Entrar no sistema.', true);
        };
        $('loginForm').onsubmit = async e => {
            e.preventDefault();
            try { await send('POST', '/api/login', {email: $('email').value, senha: $('senha').value}); location.href = '/painel.html'; }
            catch (er) { msg('loginMsg', er.message); }
        };
    },
    'registro.html'() {
        $('registerForm').onsubmit = async e => {
            e.preventDefault();
            try {
                const d = await send('POST', '/api/registro', {school: $('school').value, email: $('regEmail').value,
                    owner: $('owner').value, password: $('regPass').value, confirm: $('regConfirm').value});
                $('registerMsg').innerHTML = esc(d.mensagem) + ' <a href="/validar-demo.html">Abrir a validação de demonstração</a>';
                $('registerMsg').style.color = '#16833b';
                $('registerForm').reset();
            } catch (er) { msg('registerMsg', er.message); }
        };
    },
    'validar-demo.html'() {
        const carregar = async () => {
            const l = await api('/api/pendentes');
            $('pendList').innerHTML = l.map(x => `<p><b>${esc(x.escola)}</b><br><span class="muted">${esc(x.email)}</span><br>
                <button class="small" data-e="${esc(x.email)}">Simular aprovação</button></p>`).join('')
                || '<p class="muted">Nenhum cadastro pendente.</p>';
            document.querySelectorAll('[data-e]').forEach(b => b.onclick = async () => {
                await send('POST', '/api/aprovar', {email: b.dataset.e});
                msg('demoMsg', 'Aprovação simulada. Agora é possível entrar com o e-mail e a senha cadastrados.', true);
                carregar();
            });
        };
        carregar();
    },
    'recuperar.html'() {
        $('recoverForm').onsubmit = async e => {
            e.preventDefault();
            try { msg('recoverMsg', (await send('POST', '/api/recuperar', {email: $('recoverEmail').value})).mensagem, true); }
            catch (er) { msg('recoverMsg', er.message); }
        };
    },
    'redefinir.html'() {
        $('resetForm').onsubmit = async e => {
            e.preventDefault();
            try {
                const t = new URLSearchParams(location.search).get('token');
                msg('resetMsg', (await send('POST', '/api/redefinir', {token: t, senha: $('newPass').value})).mensagem, true);
            } catch (er) { msg('resetMsg', er.message); }
        };
    },
    async 'painel.html'() {
        const [me, p] = await Promise.all([api('/api/me'), api('/api/painel')]);
        $('schoolTitle').textContent = me.escola + ' • Visão geral';
        $('total').textContent = p.total; $('pending').textContent = p.pendentes;
        $('progress').textContent = p.andamento; $('done').textContent = p.resolvidas;
        $('activityRows').innerHTML = p.atividades.map(x => `<tr><td>${fmt(x.data)}</td><td>${esc(x.setor)}</td><td>${esc(x.acao)}</td></tr>`).join('')
            || '<tr><td colspan="3">Nenhuma atividade registrada.</td></tr>';
        const st = s => $('validationStatus').textContent = 'Status do cadastro: ' + s;
        st(me.status);
        $('approveDemo').onclick = async () => { await send('POST', '/api/aprovar'); st('aprovada (simulação)'); };
    },
    async 'ocorrencias.html'() {
        const tabela = async () => {
            const l = await api('/api/ocorrencias');
            $('occurrenceRows').innerHTML = l.map(x => `<tr><td>${esc(x.protocolo)}</td><td>${esc(x.local)}</td><td>${esc(x.categoria)}</td>
                <td>${fmt(x.criada)}</td><td>${badge(x.situacao)}</td></tr>`).join('') || '<tr><td colspan="5">Nenhuma ocorrência registrada.</td></tr>';
        };
        await tabela();
        $('occurrenceForm').onsubmit = async e => {
            e.preventDefault();
            const fd = new FormData();
            fd.append('local', $('location').value); fd.append('categoria', $('category').value);
            fd.append('titulo', $('title').value); fd.append('descricao', $('description').value);
            [...$('attachments').files].forEach(f => fd.append('anexos', f));
            try {
                const d = await api('/api/ocorrencias', {method: 'POST', body: fd});
                msg('occurrenceMsg', 'Ocorrência registrada! Protocolo: ' + d.protocolo, true);
                $('occurrenceForm').reset(); tabela();
            } catch (er) { msg('occurrenceMsg', er.message); }
        };
    },
    async 'mapa.html'() {
        const l = await api('/api/ocorrencias');
        document.querySelectorAll('.room').forEach(b => {
            const abertas = l.filter(x => x.local === b.dataset.room && !['Resolvida', 'Arquivada'].includes(x.situacao));
            b.classList.toggle('has-open', abertas.length > 0);
            b.onclick = () => {
                document.querySelectorAll('.room').forEach(x => x.classList.remove('selected'));
                b.classList.add('selected');
                const r = l.filter(x => x.local === b.dataset.room);
                $('roomTitle').textContent = b.dataset.room;
                $('roomDetails').innerHTML = r.map(x => `<p><b>${esc(x.protocolo)}</b> — ${esc(x.titulo)} ${badge(x.situacao)}<br>
                    <span class="muted">${esc(x.categoria)} • ${fmt(x.criada)}</span></p>`).join('') || 'Nenhuma ocorrência registrada para este ambiente.';
            };
        });
    },
    async 'gestao.html'() {
        let dados = await api('/api/ocorrencias');
        const desenhar = () => {
            const q = $('manageSearch').value.toLowerCase(), p = $('priorityFilter').value, s = $('statusFilter').value, c = $('categoryFilter').value;
            const l = dados.filter(x => (!q || (x.protocolo + x.local + x.titulo).toLowerCase().includes(q)) &&
                (!p || x.prioridade === p) && (!s || x.situacao === s) && (!c || x.categoria === c));
            $('manageCards').innerHTML = l.map(x => `<article class="card">
                <div class="actions" style="justify-content:space-between"><h2>${esc(x.titulo)}</h2><span class="badge">${esc(x.protocolo)}</span></div>
                <p class="muted">${esc(x.local)} • ${esc(x.categoria)} • Registrada em ${fmt(x.criada)}</p>
                <p>${esc(x.descricao)}</p>
                <p><b>Anexos:</b> ${x.anexos.length ? x.anexos.map(a => `<a href="/uploads/${esc(a.arquivo)}" target="_blank">${esc(a.nome)}</a>`).join(', ') : 'Nenhum'}</p>
                <div class="form-grid">
                  <div><label>Prioridade</label><select id="p-${x.protocolo}">${PRIOR.map(v => `<option ${x.prioridade === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
                  <div><label>Situação</label><select id="s-${x.protocolo}">${SIT.map(v => `<option ${x.situacao === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
                  <div class="full"><label>Providências / atualização</label><textarea id="a-${x.protocolo}" placeholder="Descreva as medidas tomadas"></textarea></div>
                  <div class="full"><label>Justificativa (obrigatória se marcar Não resolvida)</label><textarea id="j-${x.protocolo}" placeholder="Explique por que não foi possível resolver"></textarea></div>
                </div>
                <div class="actions"><button data-salvar="${x.protocolo}">Salvar atualização</button>
                <button class="secondary small" data-hist="${x.protocolo}">Ver histórico</button></div>
                <div id="hist-${x.protocolo}" class="muted" style="margin-top:10px"></div></article>`).join('')
                || '<div class="card empty">Nenhuma ocorrência encontrada.</div>';
            document.querySelectorAll('[data-salvar]').forEach(b => b.onclick = async () => {
                const i = b.dataset.salvar;
                try {
                    await send('PUT', '/api/ocorrencias/' + i, {prioridade: $('p-' + i).value, situacao: $('s-' + i).value,
                        providencias: $('a-' + i).value, justificativa: $('j-' + i).value});
                    dados = await api('/api/ocorrencias'); desenhar();
                } catch (er) { alert(er.message); }
            });
            document.querySelectorAll('[data-hist]').forEach(b => b.onclick = async () => {
                const h = await api(`/api/ocorrencias/${b.dataset.hist}/historico`);
                $('hist-' + b.dataset.hist).innerHTML = h.map(x => `<p>${fmt(x.data)} — ${esc(x.texto)}</p>`).join('') || 'Sem atualizações ainda.';
            });
        };
        ['manageSearch', 'priorityFilter', 'statusFilter', 'categoryFilter'].forEach(i => $(i).oninput = desenhar);
        desenhar();
    },
    async 'relatorios.html'() {
        const todas = await api('/api/ocorrencias');
        const filtrar = () => {
            const per = $('period').value, loc = $('reportLocation').value, cat = $('reportCategory').value, st = $('reportStatus').value, now = new Date();
            return todas.filter(x => {
                const d = new Date(x.criada), idade = (now - d) / 86400000;
                return (per === 'all' || (per === 'day' && d.toDateString() === now.toDateString()) || (per === 'week' && idade <= 7) || (per === 'month' && idade <= 30))
                    && (!loc || x.local === loc) && (!cat || x.categoria === cat) && (!st || x.situacao === st);
            });
        };
        const desenhar = () => {
            const a = filtrar();
            $('reportTotal').textContent = a.length;
            $('reportOpen').textContent = a.filter(x => !['Resolvida', 'Arquivada'].includes(x.situacao)).length;
            $('reportDone').textContent = a.filter(x => x.situacao === 'Resolvida').length;
            $('reportRows').innerHTML = a.map(x => `<tr><td>${esc(x.protocolo)}</td><td>${esc(x.local)}</td><td>${esc(x.categoria)}</td>
                <td>${badge(x.prioridade)}</td><td>${badge(x.situacao)}</td><td>${fmt(x.criada)}</td></tr>`).join('')
                || '<tr><td colspan="6">Nenhum resultado para os filtros.</td></tr>';
        };
        $('applyReport').onclick = desenhar;
        $('printReport').onclick = () => window.print();
        $('exportCsv').onclick = () => {
            const linhas = [['Protocolo', 'Local', 'Categoria', 'Título', 'Prioridade', 'Situação', 'Data', 'Descrição'],
                ...filtrar().map(x => [x.protocolo, x.local, x.categoria, x.titulo, x.prioridade, x.situacao, fmt(x.criada), x.descricao])];
            const csv = '\uFEFF' + linhas.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(';')).join('\n');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8;'}));
            a.download = 'relatorio-ocorrencias.csv'; a.click();
        };
        desenhar();
        const lg = await api('/api/logs');
        $('historyRows').innerHTML = lg.map(x => `<tr><td>${fmt(x.data)}</td><td>${esc(x.setor)}</td><td>${esc(x.acao)}</td></tr>`).join('')
            || '<tr><td colspan="3">Nenhuma atividade registrada.</td></tr>';
    },
    async 'comunicados.html'() {
        let lista = [];
        const desenhar = async () => {
            lista = await api('/api/comunicados');
            const item = (x, ativo) => `<div class="notice"><b>${esc(x.titulo)}</b> <span class="muted">• ${fmt(x.data)}</span>
                <p>${esc(x.mensagem).replace(/\n/g, '<br>')}</p>${ativo ? `<div class="actions">
                <button class="small secondary" data-ed="${x.id}">Editar</button>
                <button class="small warning" data-ar="${x.id}">Arquivar</button></div>` : ''}</div>`;
            const pub = lista.filter(x => !x.arquivado), arq = lista.filter(x => x.arquivado);
            $('noticeList').innerHTML = pub.map(x => item(x, true)).join('') || '<p class="muted">Nenhum comunicado publicado.</p>';
            $('archivedList').innerHTML = arq.map(x => item(x, false)).join('') || '<p class="muted">Nenhum comunicado arquivado.</p>';
            document.querySelectorAll('[data-ed]').forEach(b => b.onclick = async () => {
                const x = lista.find(v => v.id == b.dataset.ed);
                const t = prompt('Título:', x.titulo); if (t === null) return;
                const m = prompt('Mensagem:', x.mensagem); if (m === null) return;
                try { await send('PUT', '/api/comunicados/' + x.id, {titulo: t, mensagem: m}); desenhar(); } catch (er) { alert(er.message); }
            });
            document.querySelectorAll('[data-ar]').forEach(b => b.onclick = async () => {
                if (confirm('Arquivar este comunicado?')) { await send('POST', `/api/comunicados/${b.dataset.ar}/arquivar`); desenhar(); }
            });
        };
        await desenhar();
        $('noticeForm').onsubmit = async e => {
            e.preventDefault();
            try { await send('POST', '/api/comunicados', {titulo: $('noticeTitle').value, mensagem: $('noticeBody').value}); $('noticeForm').reset(); desenhar(); }
            catch (er) { alert(er.message); }
        };
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const p = location.pathname.split('/').pop() || 'index2.html';
    Promise.resolve(paginas[p] && paginas[p]()).catch(e => { if (e.message !== 'sessão') console.error(e); });
});
