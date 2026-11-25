// ─────────────────────────────────────────────────────────────────────────────
// faixa.js — BLOQUEIO POR FAIXA NÃO RESOLVIDA  (v20261124-bloqueio, PREVIEW)
//
// REGRA FECHADA COM O DLEAN (24/11):
//   1. Toda célula ATIVA no dia é cobrada — não existe mais controle por
//      responsável. Qualquer usuário logado justifica qualquer célula.
//   2. Se uma faixa encerra sem lançamento em QUALQUER célula ativa, TODAS as
//      faixas seguintes daquela UNIDADE ficam BLOQUEADAS para lançamento.
//   3. Destrava quando todas as células ativas das faixas pendentes estiverem
//      lançadas OU justificadas.
//   4. O bloqueio é por UNIDADE: Vinhedo não bloqueia Curitiba.
//   5. Nada de "Dispensar": só justificar resolve.
//   6. As justificativas aparecem na lista de lançamentos da faixa, com célula,
//      motivo e quem lançou, e podem ser canceladas — cancelar RE-BLOQUEIA,
//      com confirmação explícita.
//
// O QUE ESTE ARQUIVO **NÃO** FAZ: não altera nenhuma regra existente do app.
// Ele lê as mesmas rotas, desenha o banner e agora também trava o botão de
// lançamento. Se algo falhar, ele se desliga sozinho e o app segue como antes.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict'

  var BANNER_ID = 'faixaPendBanner'
  var CORTE = '2026-11-19' // vigência (decisão André 18/11)
  var API = 'https://painel-entregas-semanais-708f0.shrd00.internal.goskip.dev'
  var INTERVALO = 60000

  var MOTIVOS = [
    'Setup / troca de produto',
    'Manutenção',
    'Falta de material',
    'Qualidade / retrabalho',
    'Ajuste de processo',
    'Falta de operador',
    'Outro',
  ]

  var _dados = null
  var _timer = null
  var _ultimaFaixaAvisada = ''
  var _papel = ''
  var _bloqueio = null // { unidade, faixas: [...], celulas: [...] }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function hoje() {
    var d = new Date(Date.now() - 10800000)
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0')
  }

  function chave(p) {
    return p.dia + '|' + p.celula + '|' + p.faixa_ini + '|' + p.faixa_fim
  }

  var SB_URL = 'https://pntmmydzxbdxjtyglwlh.supabase.co'
  var SB_KEY = 'sb_publishable_HrKp9FJkJHSOkKR3BLHjdw_-09h_KxF'
  var _eu = null

  function lerSessao() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i)
        if (!k || k.indexOf('sb-') !== 0 || k.indexOf('auth-token') < 0) continue
        var raw = localStorage.getItem(k)
        if (!raw) continue
        var o = JSON.parse(raw)
        var s = o && (o.currentSession || o.session || o)
        if (s && s.access_token) return s
      }
    } catch (e) {}
    return null
  }

  function eu() {
    var s = lerSessao()
    if (!s || !s.access_token) return { id: '', email: '', nome: '', token: '' }
    var email = String((s.user && s.user.email) || '')
    // NOME DO OPERADOR (25/11, pedido Dlean): antes gravávamos o prefixo do
    // e-mail ('estagiariodlean', 'qualidadedlean'). O nome de verdade está na
    // tabela `perfis` do Supabase, que o app já carrega em S.perfisMap.
    var nomeReal = ''
    try {
      // 1) cache do perfil (buscado no banco por buscarPerfil)
      if (_meuPerfil && _meuPerfil.nome) nomeReal = String(_meuPerfil.nome)
      // 2) o mapa do app, se já carregou
      if (!nomeReal) {
        var uid = String((s.user && s.user.id) || '')
        var pm = (window.S && window.S.perfisMap) || null
        if (pm && uid && pm[uid] && pm[uid].nome) nomeReal = String(pm[uid].nome)
        if (!nomeReal && pm) {
          for (var k in pm) {
            if (!pm.hasOwnProperty(k)) continue
            if (String(pm[k].email || '').toLowerCase() === email.toLowerCase()) {
              nomeReal = String(pm[k].nome || '')
              break
            }
          }
        }
      }
      // 3) dispara a busca e usa na próxima chamada
      if (!nomeReal && _meuPerfil === null) buscarPerfil()
    } catch (e) {}
    _eu = {
      id: String((s.user && s.user.id) || ''),
      email: email,
      nome: nomeReal || email.split('@')[0],
      token: String(s.access_token),
    }
    return _eu
  }

  // ── BLOQUEIO ───────────────────────────────────────────────────────────────
  // Calcula, a partir da lista de pendências, quais faixas estão travadas.
  // Bloqueia da PRIMEIRA faixa pendente em diante — inclusive todas as
  // seguintes. É o comportamento pedido: "se a 07:30 ficou aberta e agora são
  // 11h, bloqueia tudo até resolver".
  function calcularBloqueio(pendencias) {
    if (!pendencias || !pendencias.length) return null
    var porUnidade = {}
    for (var i = 0; i < pendencias.length; i++) {
      var p = pendencias[i]
      var u = String(p.unidade || 'C')
      if (!porUnidade[u]) porUnidade[u] = []
      porUnidade[u].push(p)
    }
    // a MENOR faixa pendente de cada unidade define o bloqueio daquela unidade
    var res = {}
    for (var un in porUnidade) {
      if (!porUnidade.hasOwnProperty(un)) continue
      var lista = porUnidade[un]
      var menor = lista[0]
      for (var j = 1; j < lista.length; j++) {
        if (String(lista[j].faixa_ini) < String(menor.faixa_ini)) menor = lista[j]
      }
      res[un] = {
        unidade: un,
        faixa_ini: String(menor.faixa_ini),
        faixa_fim: String(menor.faixa_fim),
        pendencias: lista,
        celulas: (function () {
          var vistos = {}
          var out = []
          for (var k = 0; k < lista.length; k++) {
            if (vistos[lista[k].celula]) continue
            vistos[lista[k].celula] = true
            out.push(lista[k])
          }
          return out
        })(),
      }
    }
    return res
  }

  // ── UNIDADE DA CÉLULA (correção 25/11) ────────────────────────────────────
  // Antes a unidade era deduzida do ENDEREÇO da tela (#apontar-<cel>). Na tela
  // "Apontamento" (tabela unificada) o endereço é #apontamento, o regex não
  // casava e caía no padrão 'C' — por isso lançar em Vinhedo era bloqueado
  // pelas pendências de Curitiba (pedido Dlean: as travas são independentes).
  // Agora a unidade vem da PRÓPRIA CÉLULA que se está lançando.
  var CELULAS_VINHEDO = { CCNTI3: true }

  function unidadeDaCelula(cel) {
    return CELULAS_VINHEDO[String(cel || '').trim()] ? 'V' : 'C'
  }

  // ── QUEM PODE LANÇAR E JUSTIFICAR EM CADA UNIDADE (25/11, decisão Dlean) ──
  // "hoje só quem poderá lançar Vinhedo será projetos.sp@dlean.com.br" e a
  // restrição vale para as DUAS coisas: lançar e justificar.
  // Admin continua livre em qualquer unidade (papel = admin).
  // Não há impasse: se a responsável faltar, o admin destrava.
  var EMAILS_VINHEDO = { 'projetos.sp@dlean.com.br': true }
  var ADMINS_UIDS = null // preenchido a partir de S.perfisMap (papel do perfil)

  // ── MEU PERFIL (nome + papel), buscado NO BANCO ────────────────────────────
  // Este script roda ANTES de o app montar S.perfisMap. Depender dele fazia:
  //   • um admin ser tratado como operador (corrigido em 20261125f)
  //   • a justificativa gravar o PREFIXO DO E-MAIL em vez do nome — voltou a
  //     acontecer em 25/11 14:03 ('qualidadedlean' em vez de 'Marcos')
  // Agora nome e papel vêm da mesma consulta, feita com a sessão do usuário.
  var _meuPerfil = null // { nome, papel } | null = ainda não buscado
  var _perfilBuscando = false
  var SB_URL = 'https://pntmmydzxbdxjtyglwlh.supabase.co'
  var SB_ANON = 'sb_publishable_HrKp9FJkJHSOkKR3BLHjdw_-09h_KxF'

  function buscarPerfil(cb) {
    if (_meuPerfil !== null) { if (cb) cb(_meuPerfil); return }

    // 1) o que o app já carregou (rápido, quando disponível)
    try {
      var me0 = eu()
      var pm0 = (window.S && window.S.perfisMap) || null
      if (pm0 && me0 && me0.id && pm0[me0.id] && (pm0[me0.id].nome || pm0[me0.id].papel)) {
        _meuPerfil = { nome: String(pm0[me0.id].nome || ''), papel: String(pm0[me0.id].papel || '') }
        if (cb) cb(_meuPerfil)
        return
      }
      if (window.S && window.S.perfil && (window.S.perfil.nome || window.S.perfil.papel)) {
        _meuPerfil = { nome: String(window.S.perfil.nome || ''), papel: String(window.S.perfil.papel || '') }
        if (cb) cb(_meuPerfil)
        return
      }
    } catch (e0) {}

    // 2) busca no banco
    if (_perfilBuscando) { if (cb) cb(_meuPerfil || { nome: '', papel: '' }); return }
    _perfilBuscando = true
    var me = eu()
    if (!me.id || !me.token) {
      _perfilBuscando = false
      if (cb) cb({ nome: '', papel: '' })
      return
    }
    fetch(SB_URL + '/rest/v1/perfis?select=user_id,nome,email,papel', {
      headers: { apikey: SB_ANON, Authorization: 'Bearer ' + me.token },
    })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (rows) {
        var achou = { nome: '', papel: '' }
        if (Array.isArray(rows)) {
          for (var i = 0; i < rows.length; i++) {
            if (String(rows[i].user_id) === String(me.id)) {
              achou = { nome: String(rows[i].nome || ''), papel: String(rows[i].papel || '') }
              break
            }
          }
        }
        _meuPerfil = achou
        _perfilBuscando = false
        if (cb) cb(achou)
      })
      .catch(function () {
        _perfilBuscando = false
        if (cb) cb({ nome: '', papel: '' })
      })
  }

  function papelDoUsuario() {
    if (_meuPerfil === null) buscarPerfil()
    return (_meuPerfil && _meuPerfil.papel) || ''
  }

  function ehAdmin() {
    return papelDoUsuario() === 'admin'
  }

  // Pode agir nesta unidade? (lançar E justificar)
  function podeAgirNaUnidade(un) {
    var u = String(un || 'C')
    if (ehAdmin()) return true // admin: todas as unidades
    var me = eu()
    var email = String(me.email || '').toLowerCase()
    if (u === 'V') {
      // Vinhedo: SÓ o e-mail responsável (ou admin, tratado acima)
      return !!EMAILS_VINHEDO[email]
    }
    // Curitiba: todos os demais (quem é de Vinhedo não lança em Curitiba)
    return !EMAILS_VINHEDO[email]
  }

  function podeAgirNaCelula(cel) {
    return podeAgirNaUnidade(unidadeDaCelula(cel))
  }

  // A célula está bloqueada nesta faixa? (null = livre)
  function celulaBloqueada(cel, faixaIni) {
    return faixaBloqueada(unidadeDaCelula(cel), faixaIni)
  }

  // A faixa 'ini' desta unidade está bloqueada?
  // ── CRONOLOGIA (correção 24/11) ────────────────────────────────────────────
  // A regra anterior bloqueava "da faixa pendente em diante" — inclusive a
  // PRÓPRIA faixa pendente. Resultado: impasse. A 07:30 ficava bloqueada por
  // estar pendente, e como não dava para lançar nela, nunca saía do bloqueio.
  //
  // A ordem correta é a dos FATOS: a faixa N só pode ser lançada se TODAS as
  // faixas ANTERIORES estiverem resolvidas. A faixa pendente em si continua
  // aberta — é justamente onde se resolve.
  //
  //   pendência na 07:30 → 07:30 LIVRE (resolver aqui)
  //                        09:00 BLOQUEADA, 10:00 BLOQUEADA, ...
  //   resolvida a 07:30  → 09:00 fica livre
  function faixaBloqueada(unidade, faixaIni) {
    if (!_bloqueio) return null
    var b = _bloqueio[String(unidade || 'C')]
    if (!b) return null
    // bloqueia apenas as faixas POSTERIORES à pendência
    if (String(faixaIni) > String(b.faixa_ini)) return b
    return null
  }

  // A faixa está pendente (é ela que precisa ser resolvida)?
  function faixaPendente(unidade, faixaIni) {
    if (!_bloqueio) return false
    var b = _bloqueio[String(unidade || 'C')]
    if (!b) return false
    return String(faixaIni) === String(b.faixa_ini)
  }

  // ── BANNER ─────────────────────────────────────────────────────────────────
  function criar() {
    var b = document.getElementById(BANNER_ID)
    if (b) return b
    b = document.createElement('div')
    b.id = BANNER_ID
    b.style.cssText = [
      'position:relative',
      'z-index:900',
      'display:none',
      'color:#fff',
      'font-family:inherit',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)',
    ].join(';')
    var alvo = document.querySelector('header.top') || document.querySelector('header') || null
    if (alvo && alvo.parentNode) alvo.parentNode.insertBefore(b, alvo.nextSibling)
    else document.body.insertBefore(b, document.body.firstChild)
    return b
  }

  var _pisca = null
  function piscar(ligar, el) {
    var b = el || document.getElementById(BANNER_ID)
    if (!b) return
    if (ligar) {
      if (_pisca) return
      var on = false
      _pisca = setInterval(function () {
        on = !on
        b.style.background = on ? '#dc2626' : '#b91c1c'
      }, 900)
    } else {
      if (_pisca) { clearInterval(_pisca); _pisca = null }
      b.style.background = '#b91c1c'
    }
  }

  function render() {
    var b = criar()
    var lista = (_dados && _dados.pendencias) || []

    if (hoje() < CORTE) { b.style.display = 'none'; piscar(false); return }

    if (!lista.length) {
      b.style.display = 'none'
      piscar(false)
      var velho = document.getElementById('faixaPainel')
      if (velho) velho.parentNode.removeChild(velho)
      return
    }

    // ── BANNER SEGREGADO POR UNIDADE (25/11, pedido Dlean) ──────────────────
    // Antes: "Curitiba: 10 · Vinhedo: 2" numa linha só — não dizia o que travava
    // o quê. Agora cada unidade tem o seu bloco, com título, o que ela trava e
    // o seu próprio botão. Quem não pode agir na unidade não recebe o botão.
    var porUn = {}
    for (var iu = 0; iu < lista.length; iu++) {
      var uu = String(lista[iu].unidade || 'C')
      if (!porUn[uu]) porUn[uu] = []
      porUn[uu].push(lista[iu])
    }
    var CORES = {
      C: { bg: '#b91c1c', nome: 'CURITIBA' },
      V: { bg: '#7c3aed', nome: 'VINHEDO' },
    }
    var todasUn = Object.keys(porUn).sort()
    var adm = ehAdmin()
    var blocos = todasUn.map(function (u) {
      var itensU = porUn[u]
      var cor = CORES[u] || CORES.C
      var cels = []
      var vistos = {}
      for (var k2 = 0; k2 < itensU.length; k2++) {
        var nm = String(itensU[k2].celula_nome || itensU[k2].celula || '')
        if (!nm || vistos[nm]) continue
        vistos[nm] = true
        cels.push(nm)
      }
      var listaCels = cels.slice(0, 3).join(', ') + (cels.length > 3 ? ' +' + (cels.length - 3) : '')
      var pode = podeAgirNaUnidade(u)
      var botao
      if (pode) {
        botao = '<button data-ver-un="' + u + '" style="background:#fff;color:' + cor.bg +
          ';border:0;border-radius:7px;padding:7px 16px;font-weight:800;font-size:12.5px;' +
          'cursor:pointer">Ver e resolver</button>'
      } else {
        botao = '<span style="opacity:.78;font-size:11.5px;font-style:italic">só ' +
          (u === 'V' ? 'projetos.sp@dlean.com.br' : 'Curitiba') + '</span>'
      }
      return '<div style="display:flex;align-items:center;gap:12px;padding:9px 15px;' +
        'flex-wrap:wrap;background:' + cor.bg + ';border-bottom:1px solid rgba(255,255,255,.18)">' +
        '<b style="font-size:11.5px;letter-spacing:.7px;background:rgba(0,0,0,.22);' +
        'padding:3px 9px;border-radius:5px">' + cor.nome + '</b>' +
        '<b style="font-size:13.5px">' + itensU.length +
        (itensU.length === 1 ? ' faixa a resolver' : ' faixas a resolver') + '</b>' +
        '<span style="flex:1;min-width:130px;opacity:.92;font-size:12px">trava: ' +
        esc(listaCels) + '</span>' + botao + '</div>'
    }).join('')

    b.style.background = (CORES[todasUn[0]] || CORES.C).bg
    b.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;padding:8px 15px;' +
      'background:#0f172a;color:#fff">' +
      '<span style="font-size:15px">🔒</span>' +
      '<b style="font-size:13px">Bloqueio por unidade</b>' +
      '<span style="flex:1;font-size:11.5px;opacity:.8">lançar ou justificar na ordem das faixas' +
      (adm ? ' · você é admin, libera as duas' : '') + '</span></div>' + blocos

    b.style.display = 'block'
    piscar(true)

    var botoes = b.querySelectorAll('[data-ver-un]')
    for (var ib = 0; ib < botoes.length; ib++) {
      botoes[ib].onclick = (function (btn) {
        return function () {
          abrirPainel(porUn[btn.getAttribute('data-ver-un')] || [])
        }
      })(botoes[ib])
    }
  }

  // ── PAINEL DE RESOLUÇÃO ────────────────────────────────────────────────────
  function abrirPainel(lista) {
    var velho = document.getElementById('faixaPainel')
    if (velho) velho.parentNode.removeChild(velho)

    var m = document.createElement('div')
    m.id = 'faixaPainel'
    m.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99995',
      'background:rgba(0,0,0,.62)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:16px',
    ].join(';')

    // ordena por unidade, depois por faixa, depois por célula
    var ordenadas = lista.slice().sort(function (a, b) {
      var ua = String(a.unidade || 'C'), ub = String(b.unidade || 'C')
      if (ua !== ub) return ua < ub ? -1 : 1
      var fa = String(a.faixa_ini || ''), fb = String(b.faixa_ini || '')
      if (fa !== fb) return fa < fb ? -1 : 1
      var na = String(a.celula_nome || ''), nb = String(b.celula_nome || '')
      return na < nb ? -1 : na > nb ? 1 : 0
    })

    var faixaAtual = ''
    var unidadeAtual = ''
    var linhas = ordenadas.map(function (p) {
      var cab = ''
      var un = String(p.unidade || 'C')
      if (un !== unidadeAtual) {
        unidadeAtual = un
        faixaAtual = ''
        cab += '<div style="background:#1f2937;color:#fff;padding:9px 14px;font-weight:800;' +
          'font-size:12.5px;letter-spacing:.4px">' +
          (un === 'V' ? 'VINHEDO' : 'CURITIBA') + '</div>'
      }
      if (String(p.faixa_ini) !== faixaAtual) {
        faixaAtual = String(p.faixa_ini)
        cab += '<div style="background:#f3f4f6;padding:8px 14px;font-weight:800;' +
          'font-size:12.5px;color:#374151;border-top:1px solid #e5e7eb">' +
          esc(p.faixa_ini) + '–' + esc(p.faixa_fim) + '</div>'
      }
      // A PRIMEIRA faixa pendente de cada unidade é a que se resolve AGORA.
      // As seguintes só abrem depois — marcar isso evita a pessoa tentar
      // resolver tudo de uma vez e não entender por que o banner não some.
      var limUn = (_bloqueio && _bloqueio[String(p.unidade || 'C')])
        ? String(_bloqueio[String(p.unidade || 'C')].faixa_ini) : ''
      var ehAtual = limUn && String(p.faixa_ini) === limUn
      var tagAgora = ehAtual
        ? '<span style="background:#059669;color:#fff;border-radius:5px;padding:2px 7px;' +
          'font-size:10.5px;font-weight:800;letter-spacing:.4px">RESOLVA AGORA</span> '
        : '<span style="background:#e5e7eb;color:#6b7280;border-radius:5px;padding:2px 7px;' +
          'font-size:10.5px;font-weight:700">depois desta</span> '
      return cab +
        '<div style="display:flex;align-items:center;gap:12px;padding:11px 13px;' +
        'border-bottom:1px solid #e5e7eb;flex-wrap:wrap' +
        (ehAtual ? ';background:#f0fdf4' : '') + '">' +
        '  <div style="flex:1;min-width:170px">' +
        '    <div style="font-weight:800;font-size:13.5px;color:#111827">' + tagAgora +
        esc(p.celula_nome) + '</div>' +
        '    <div style="font-size:12px;color:#6b7280">programado ' + (p.meta || 0) + ' un · lançado 0</div>' +
        '  </div>' +
        '  <button data-mot="' + esc(chave(p)) + '" style="background:#991b1b;color:#fff;' +
        'border:0;border-radius:7px;padding:8px 14px;font-weight:800;font-size:12.5px;' +
        'cursor:pointer;white-space:nowrap">Justificar</button>' +
        '</div>'
    }).join('')

    m.innerHTML =
      '<div style="background:#fff;border-radius:12px;max-width:640px;width:100%;' +
      'font-family:inherit;max-height:86vh;display:flex;flex-direction:column">' +
      '  <div style="padding:16px 18px 12px;border-bottom:1px solid #e5e7eb">' +
      '    <h3 style="margin:0;font-size:17px;color:#111827">Faixas bloqueadas</h3>' +
      '    <div style="color:#6b7280;font-size:12.5px;margin-top:3px">' +
      'Resolva na ordem: cada faixa libera a seguinte · dia ' +
      esc(hoje().split('-').reverse().join('/')) + '</div>' +
      '  </div>' +
      '  <div style="overflow:auto">' + linhas + '</div>' +
      '  <div style="padding:12px 18px;text-align:right;border-top:1px solid #e5e7eb">' +
      '    <button id="faixaPainelOk" style="background:#f3f4f6;color:#374151;border:0;' +
      'border-radius:7px;padding:9px 18px;font-weight:700;font-size:13px;cursor:pointer">Fechar</button>' +
      '  </div>' +
      '</div>'

    document.body.appendChild(m)
    document.getElementById('faixaPainelOk').onclick = function () {
      m.parentNode.removeChild(m)
    }

    var botoes = m.querySelectorAll('[data-mot]')
    for (var i = 0; i < botoes.length; i++) {
      botoes[i].onclick = (function (btn) {
        return function () {
          var k = btn.getAttribute('data-mot')
          var alvo = null
          for (var j = 0; j < ordenadas.length; j++) {
            if (chave(ordenadas[j]) === k) { alvo = ordenadas[j]; break }
          }
          if (alvo) abrirMotivos(alvo, m)
        }
      })(botoes[i])
    }
  }

  // ── ESCOLHA DO MOTIVO ──────────────────────────────────────────────────────
  function abrirMotivos(p, painelPai) {
    var velho = document.getElementById('faixaMotivos')
    if (velho) velho.parentNode.removeChild(velho)

    var m = document.createElement('div')
    m.id = 'faixaMotivos'
    m.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99996',
      'background:rgba(0,0,0,.62)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:16px',
    ].join(';')

    var botoes = MOTIVOS.map(function (mot) {
      return '<button data-mot="' + esc(mot) + '" style="background:#fff;color:#111827;' +
        'border:1px solid #d1d5db;border-radius:8px;padding:14px 12px;font-size:13.5px;' +
        'font-weight:700;cursor:pointer;text-align:left">' + esc(mot) + '</button>'
    }).join('')

    m.innerHTML =
      '<div style="background:#fff;border-radius:12px;max-width:560px;width:100%;' +
      'padding:18px;font-family:inherit;max-height:88vh;overflow:auto">' +
      '  <div style="font-size:12px;color:#6b7280;font-weight:700;letter-spacing:.4px">' +
      esc(p.celula_nome).toUpperCase() + ' · ' + esc(p.faixa_ini) + '–' + esc(p.faixa_fim) + '</div>' +
      '  <h3 style="margin:6px 0 2px;font-size:17px;color:#111827">Qual o motivo?</h3>' +
      '  <div style="color:#6b7280;font-size:12.5px;margin-bottom:14px">' +
      'Nenhum lançamento nesta faixa — informe o motivo para liberar</div>' +
      '  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' + botoes + '</div>' +
      '  <div style="margin-top:14px;text-align:right">' +
      '    <button id="faixaCancelar" style="background:#f3f4f6;color:#374151;border:0;' +
      'border-radius:7px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>' +
      '  </div>' +
      '</div>'

    document.body.appendChild(m)
    document.getElementById('faixaCancelar').onclick = function () {
      m.parentNode.removeChild(m)
    }

    var opts = m.querySelectorAll('[data-mot]')
    for (var i = 0; i < opts.length; i++) {
      opts[i].onclick = (function (btn) {
        return function () {
          btn.disabled = true
          btn.textContent = 'Gravando…'
          salvar(p, btn.getAttribute('data-mot'), m, painelPai)
        }
      })(opts[i])
    }
  }

  function salvar(p, motivo, modal, painelPai) {
    // O NOME PRECISA ESTAR RESOLVIDO ANTES DE GRAVAR (25/11, 2ª vez).
    // Antes daqui, `eu().nome` caía no prefixo do e-mail ('qualidadedlean')
    // porque S.perfisMap ainda não existia. Agora esperamos o perfil do banco.
    buscarPerfil(function () {
      var me = eu()
      var corpo = {
        dia: p.dia,
        celula: p.celula,
        celula_nome: p.celula_nome,
        unidade: String(p.unidade || 'C'),
        faixa_ini: p.faixa_ini,
        faixa_fim: p.faixa_fim,
        faixa_idx: p.faixa_idx,
        motivo: motivo,
        obs: '',
        tipo: p.tipo,
        qtd_apontada: p.produzido,
        meta_faixa: p.meta,
        quem: me.nome || me.email,
        quem_id: me.id,
      }
      fetch(API + '/backend/v1/compass2/justificativa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function () {
        if (modal && modal.parentNode) modal.parentNode.removeChild(modal)
        if (painelPai && painelPai.parentNode) painelPai.parentNode.removeChild(painelPai)
        buscar()
      })
      .catch(function (e) {
        if (modal) {
          var b = modal.querySelector('button[data-mot]')
          if (b) b.textContent = 'Erro: ' + e.message
        }
      })
    })
  }

  // ── TRAVA DO BOTÃO DE LANÇAR ───────────────────────────────────────────────
  // Esta é a parte que muda o comportamento do app. É defensiva: se não
  // conseguir decidir, NÃO bloqueia (o app nunca quebra por causa do banner).
  function aplicarTrava() {
    try {
      var btn = document.getElementById('pc-send')
      var aviso = document.getElementById('bloqAviso')

      // sem bloqueio ou fora da vigência: garante o botão livre
      if (hoje() < CORTE || !_bloqueio) {
        if (btn) {
          btn.disabled = false
          btn.style.opacity = ''
          btn.style.cursor = ''
          btn.removeAttribute('title')
        }
        if (aviso && aviso.parentNode) aviso.parentNode.removeChild(aviso)
        return
      }

      // descobre a unidade e a faixa que o app está prestes a usar.
      //
      // CUIDADO (corrigido 24/11): o app escreve a faixa com a função `short()`,
      // que CORTA o ':00'. O botão diz "Lançar na faixa 09–10", não "09:00–10:00".
      // O regex antigo exigia HH:MM e nunca casava → a trava não agia nunca.
      // Agora aceitamos as duas formas e normalizamos para HH:MM.
      var iniFaixa = ''
      if (btn) {
        var txtBtn = String(btn.textContent || '')
        var m = /Lançar na faixa\s+(\d{1,2})(?::(\d{2}))?/.exec(txtBtn)
        if (m) {
          var hh = String(m[1]).length === 1 ? '0' + m[1] : String(m[1])
          iniFaixa = hh + ':' + (m[2] || '00')
        }
      }

      // unidade: vem da CÉLULA aberta (não do endereço). Ver unidadeDaCelula.
      var un = 'C'
      try {
        var h = String(location.hash || '')
        var mm = /apontar-([A-Za-z0-9]+)/.exec(h)
        if (mm) un = unidadeDaCelula(mm[1])
      } catch (e0) {}

      if (!iniFaixa) return // não conseguimos ler: não bloqueia

      // PERMISSÃO POR UNIDADE (25/11): quem não pode agir na unidade não lança
      var celAberta = ''
      try {
        var hx = String(location.hash || '')
        var mx = /apontar-([A-Za-z0-9]+)/.exec(hx)
        if (mx) celAberta = mx[1]
      } catch (e9) {}
      var semPermissao = celAberta && !podeAgirNaCelula(celAberta)

      var b = faixaBloqueada(un, iniFaixa)
      if (semPermissao) {
        if (btn) {
          btn.disabled = true
          btn.style.opacity = '0.5'
          btn.style.cursor = 'not-allowed'
          btn.setAttribute('title', 'sem permissão nesta unidade')
        }
        if (!aviso) {
          aviso = document.createElement('div')
          aviso.id = 'bloqAviso'
          aviso.style.cssText = 'margin-top:10px;background:#fef2f2;border:1px solid #fecaca;' +
            'color:#991b1b;border-radius:8px;padding:10px 12px;font-size:12.5px;font-weight:600'
          if (btn && btn.parentNode) btn.parentNode.insertBefore(aviso, btn)
        }
        aviso.innerHTML = '🚫 ' + esc(motivoSemPermissao(celAberta))
        return
      }
      if (!b) {
        if (btn) {
          btn.disabled = false
          btn.style.opacity = ''
          btn.style.cursor = ''
          btn.removeAttribute('title')
        }
        if (aviso && aviso.parentNode) aviso.parentNode.removeChild(aviso)
        return
      }

      // BLOQUEADO: desabilita e explica
      var nomes = b.celulas.slice(0, 4).map(function (x) { return x.celula_nome }).join(', ')
      var resto = b.celulas.length > 4 ? ' +' + (b.celulas.length - 4) : ''
      if (btn) {
        btn.disabled = true
        btn.style.opacity = '0.5'
        btn.style.cursor = 'not-allowed'
        btn.setAttribute('title', 'Faixa bloqueada: resolva a faixa ' + b.faixa_ini)
      }
      if (!aviso) {
        aviso = document.createElement('div')
        aviso.id = 'bloqAviso'
        aviso.style.cssText = 'margin-top:10px;background:#fef2f2;border:1px solid #fecaca;' +
          'color:#991b1b;border-radius:8px;padding:10px 12px;font-size:12.5px;font-weight:600'
        if (btn && btn.parentNode) btn.parentNode.insertBefore(aviso, btn)
      }
      aviso.innerHTML = '🔒 Bloqueado pela faixa ' + esc(b.faixa_ini) + '–' + esc(b.faixa_fim) +
        '. Falta lançar ou justificar: <b>' + esc(nomes + resto) + '</b>. ' +
        '<button id="bloqAbrir" style="background:#991b1b;color:#fff;border:0;' +
        'border-radius:6px;padding:5px 10px;font-weight:800;font-size:12px;cursor:pointer;' +
        'margin-left:6px">Resolver</button>'
      var ab = document.getElementById('bloqAbrir')
      if (ab) ab.onclick = function () { abrirPainel(b.pendencias) }
    } catch (e) {
      // nunca deixar a trava quebrar o app
      try {
        var bt = document.getElementById('pc-send')
        if (bt) bt.disabled = false
      } catch (e2) {}
    }
  }

  // ── INTERCEPTAÇÃO DO LANÇAMENTO (24/11) ───────────────────────────────────
  // Desabilitar o botão não basta: o app recria o DOM e o clique pode vir do
  // "Lançar por caixa" (lote) ou de outra via. Aqui envolvemos o `pcLancar`
  // do app: se a faixa estiver bloqueada, recusamos com aviso.
  function interceptarLancamento() {
    try {
      if (window.__faixaTravaLancamento) return
      // pcLancar vive no IIFE do app → não é acessível. O que dá para fazer é
      // capturar o clique antes do app (capture phase) no botão de enviar.
      // A conversa NÃO é só o #pc-send. O app tem 4 caminhos de lançamento:
      //   #pc-send              -> "Lançar na faixa 13–14"      (PC da célula)
      //   #tu-send              -> "Lançar faixa 13–14"         (tabela unificada)
      //   #pend-ok              -> fecha a faixa pelo modal
      //   botões de lote/caixa  -> lançam N unidades de uma vez
      // A interceptação é por TEXTO do botão, não por id: assim pega todos,
      // inclusive os que o app criar depois.
      document.addEventListener(
        'click',
        function (ev) {
          try {
            if (hoje() < CORTE || !_bloqueio) return
            var alvo = ev.target
            if (!alvo) return
            var btn = alvo.closest ? alvo.closest('button') : null
            if (!btn) return
            var txt = String(btn.textContent || '')

            // hora extra nunca é bloqueada (não é faixa normal)
            if (/hora extra/i.test(txt)) return

            // extrai a faixa do texto do botão, aceitando todas as formas:
            //   "Lançar na faixa 13–14"  |  "Lançar faixa 13–14"
            //   "Lançar na faixa 07:30–09"  |  "Lançar na faixa 11–12"
            var m = /faixa\s+(\d{1,2})(?::(\d{2}))?\s*[–\-]/i.exec(txt)
            var ini = ''
            if (m) {
              var hh = String(m[1]).length === 1 ? '0' + m[1] : String(m[1])
              ini = hh + ':' + (m[2] || '00')
            } else if (btn.id === 'pend-ok') {
              // o modal "fechar faixa" não traz o horário no texto: usamos a
              // faixa que ele está fechando
              var d = btn.getAttribute('data-fx')
              if (d == null) return
              var fx = Number(d)
              if (!isFinite(fx) || fx < 0) return // hora extra
              var listaF = (_dados && _dados.faixas) || []
              if (!listaF[fx]) return
              ini = String(listaF[fx].ini || '')
            } else {
              return
            }
            if (!ini) return

            // unidade pela CÉLULA aberta (não pelo endereço)
            var un = 'C'
            try {
              var hh2 = String(location.hash || '')
              var mm2 = /apontar-([A-Za-z0-9]+)/.exec(hh2)
              if (mm2) un = unidadeDaCelula(mm2[1])
            } catch (e0) {}

            // PERMISSÃO: descobre a célula do lançamento (PC usa a célula aberta)
            var celLanc = ''
            try {
              var mh = /apontar-([A-Za-z0-9]+)/.exec(String(location.hash || ''))
              if (mh) celLanc = mh[1]
            } catch (eP) {}
            if (celLanc && !podeAgirNaCelula(celLanc)) {
              ev.preventDefault()
              ev.stopPropagation()
              ev.stopImmediatePropagation()
              try { toast(motivoSemPermissao(celLanc)) } catch (eT) {
                alert(motivoSemPermissao(celLanc))
              }
              return
            }

            var b = faixaBloqueada(un, ini)
            if (!b) return

            ev.preventDefault()
            ev.stopPropagation()
            ev.stopImmediatePropagation()
            var nomes = b.celulas.slice(0, 3).map(function (x) { return x.celula_nome }).join(', ')
            var resto = b.celulas.length > 3 ? ' +' + (b.celulas.length - 3) : ''
            try {
              toast('Bloqueado pela faixa ' + b.faixa_ini + '–' + b.faixa_fim +
                '. Falta: ' + nomes + resto, { tipo: 'erro' })
            } catch (eT) {
              alert('Bloqueado pela faixa ' + b.faixa_ini + '. Falta: ' + nomes + resto)
            }
            abrirPainel(b.pendencias)
          } catch (e1) {}
        },
        true, // capture: roda ANTES do handler do app
      )
      // botão Cancelar das justificativas na lista de lançamentos
      document.addEventListener(
        'click',
        function (ev) {
          try {
            var alvo = ev.target
            if (!alvo || !alvo.closest) return
            var btn = alvo.closest('[data-just-cancel]')
            if (!btn) return
            ev.preventDefault()
            ev.stopPropagation()
            ev.stopImmediatePropagation()
            cancelarJustificativa(
              btn.getAttribute('data-just-cancel'),
              btn.getAttribute('data-just-cel'),
              btn.getAttribute('data-just-motivo'),
            )
          } catch (e) {}
        },
        true,
      )
      window.__faixaTravaLancamento = true
    } catch (e) {}
  }

  // ── JUSTIFICATIVAS DO DIA (25/11) ──────────────────────────────────────────
  // Pedido Dlean: a célula que foi JUSTIFICADA precisa aparecer na lista de
  // lançamentos da faixa — com nome, motivo e quem lançou — e poder ser
  // cancelada (o que devolve a faixa a pendente e re-bloqueia).
  var _justificativas = []

  function carregarJustificativas(cb) {
    fetch(
      API +
        '/api/collections/andon_justificativas/records?perPage=300&sort=faixa_idx&filter=' +
        encodeURIComponent("dia='" + hoje() + "'"),
    )
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) {
        _justificativas = (d && d.items) || []
        publicarParaLista()
        if (cb) cb()
      })
      .catch(function () { if (cb) cb() })
  }

  // ── PONTE COM A LISTA DE LANÇAMENTOS (25/11) ───────────────────────────────
  // A lista "Lançamentos da faixa" vive no index.html. Aqui deixamos as
  // justificativas disponíveis para ela, para aparecerem junto dos apontamentos
  // (com célula, motivo, quem lançou e botão Cancelar).
  function publicarParaLista() {
    try {
      // API usada pela tabela unificada (tuLancar) para decidir CÉLULA a CÉLULA.
      // `bloqueada(cel, faixaIni)` devolve null (livre) ou o objeto do bloqueio.
      window.FAIXA_BLOQ = {
        unidadeDaCelula: unidadeDaCelula,
        bloqueada: function (cel, faixaIni) { return celulaBloqueada(cel, faixaIni) },
        // permissão por unidade (lançar E justificar)
        podeAgirNaUnidade: podeAgirNaUnidade,
        podeAgirNaCelula: podeAgirNaCelula,
        ehAdmin: ehAdmin,
        // por que não pode (mensagem pronta para o app usar)
        motivoSemPermissao: function (cel) {
          var u = unidadeDaCelula(cel)
          var nome = u === 'V' ? 'Vinhedo' : 'Curitiba'
          if (u === 'V') return 'Só projetos.sp@dlean.com.br lança em ' + nome
          return 'Vinhedo lança apenas em Vinhedo'
        },
        pendenciasDaCelula: function (cel, faixaIni) {
          var b = celulaBloqueada(cel, faixaIni)
          if (!b) return []
          var u = unidadeDaCelula(cel)
          return (b.pendencias || []).filter(function (p) {
            return String(p.unidade || 'C') === u
          })
        },
        ativo: function () { return hoje() >= CORTE },
      }
    } catch (e) {}
    try {
      window.FAIXA_JUST = {
        todas: function () { return _justificativas.slice() },
        daFaixa: function (fx) {
          var out = []
          for (var i = 0; i < _justificativas.length; i++) {
            if (Number(_justificativas[i].faixa_idx) === Number(fx)) out.push(_justificativas[i])
          }
          return out
        },
        recarregar: function () { carregarJustificativas(render) },
      }
    } catch (e) {}
  }

  // ── CANCELAR JUSTIFICATIVA (com o aviso combinado) ─────────────────────────
  // Cancelar devolve a faixa a PENDENTE e re-bloqueia as seguintes. Por isso
  // pede confirmação explícita e diz exatamente o efeito.
  function cancelarJustificativa(id, celula, motivo) {
    var msg =
      'Cancelar esta justificativa?\n\n' +
      celula + '\n' +
      'Motivo: ' + (motivo || '(sem motivo)') + '\n\n' +
      'Ao cancelar, esta faixa volta a ficar PENDENTE e BLOQUEIA o lançamento ' +
      'das faixas seguintes desta unidade até que seja resolvida.'
    if (!window.confirm(msg)) return
    // A coleção não aceita DELETE do cliente (deleteRule=null): quem cancela é
    // a rota do servidor, que registra quem cancelou.
    fetch(API + '/backend/v1/compass2/justificativa-cancelar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmar: 'CANCELAR',
        id: String(id || ''),
        quem: (function () { try { return (eu() || {}).nome || '' } catch (e) { return '' } })(),
      }),
    })
      .then(function (r) { return r.ok ? r.json() : null })
      .catch(function () { return null })
      .then(function (d) {
        if (!d || !d.ok) {
          try {
            alert('Não foi possível cancelar agora. Tente de novo em instantes.')
          } catch (e) {}
        }
        carregarJustificativas(function () {
          buscarPendencias()
        })
      })
  }

  function justificativaDa(cel, faixaIdx) {
    for (var i = 0; i < _justificativas.length; i++) {
      var j = _justificativas[i]
      if (String(j.celula) !== String(cel)) continue
      if (Number(j.faixa_idx) !== Number(faixaIdx)) continue
      return j
    }
    return null
  }

  function buscar() {
    if (hoje() < CORTE) return
    // o papel precisa estar resolvido ANTES de desenhar: um admin tratado como
    // operador veria "só projetos.sp lança em Vinhedo" e ficaria travado.
    buscarPapel(function () {
      carregarJustificativas(function () {
        buscarPendencias()
      })
    })
  }

  function buscarPendencias() {
    fetch(API + '/backend/v1/compass2/pendencias?data=' + hoje())
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (d) {
        _dados = d
        _bloqueio = calcularBloqueio(d.pendencias || [])
        render()
        aplicarTrava()
        talvezAvisar(d.pendencias || [])
      })
      .catch(function () {})
  }

  // popup na virada de faixa (agora para todos)
  function chaveDaFaixaAtual() {
    var d = new Date(Date.now() - 10800000)
    return 'h' + d.getUTCHours()
  }

  function talvezAvisar(lista) {
    if (!lista.length) return
    var k = chaveDaFaixaAtual()
    if (_ultimaFaixaAvisada === k) return
    var agoraD = new Date(Date.now() - 10800000)
    if (agoraD.getUTCHours() >= 17) { _ultimaFaixaAvisada = k; return }
    _ultimaFaixaAvisada = k
    abrirPopup(lista, k.replace('h', '') + ':00')
  }

  function abrirPopup(lista, faixa) {
    var velho = document.getElementById('faixaPopup')
    if (velho) velho.parentNode.removeChild(velho)
    var m = document.createElement('div')
    m.id = 'faixaPopup'
    m.style.cssText = 'position:fixed;inset:0;z-index:99994;background:rgba(0,0,0,.55);' +
      'display:flex;align-items:center;justify-content:center;padding:18px'
    var itens = lista.slice(0, 8).map(function (p) {
      return '<div style="display:flex;gap:10px;padding:9px 12px;border-bottom:1px solid #e5e7eb">' +
        '<span style="flex:1;font-size:13px"><b>' + esc(p.celula_nome) + '</b>' +
        '<span style="color:#6b7280"> · ' + esc(p.faixa_ini) + '–' + esc(p.faixa_fim) + '</span></span>' +
        '</div>'
    }).join('')
    m.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:580px;width:100%;' +
      'font-family:inherit;max-height:88vh;display:flex;flex-direction:column;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.4)">' +
      '<div style="padding:18px 20px 14px;border-bottom:1px solid #e5e7eb;background:#fef2f2;' +
      'border-radius:14px 14px 0 0">' +
      '<div style="display:flex;align-items:center;gap:10px"><span style="font-size:22px">🔒</span>' +
      '<div><div style="font-size:16px;font-weight:800;color:#991b1b">Lançamento bloqueado</div>' +
      '<div style="font-size:12.5px;color:#7f1d1d;margin-top:2px">' + lista.length +
      ' faixa(s) sem lançamento — resolva para continuar</div></div></div></div>' +
      '<div style="overflow:auto">' + itens + '</div>' +
      '<div style="padding:12px 20px;text-align:right;border-top:1px solid #e5e7eb">' +
      '<button id="faixaPopupOk" style="background:#f3f4f6;color:#374151;border:0;' +
      'border-radius:8px;padding:10px 20px;font-weight:700;font-size:13px;cursor:pointer">' +
      'Ver pendências</button></div></div>'
    document.body.appendChild(m)
    document.getElementById('faixaPopupOk').onclick = function () {
      m.parentNode.removeChild(m)
      abrirPainel(lista)
    }
  }

  function iniciar() {
    var tentativas = 0
    function tenta() {
      var s = lerSessao()
      if (!s) {
        if (++tentativas > 240) return
        return setTimeout(tenta, 500)
      }
      interceptarLancamento()
      buscar()
      if (_timer) clearInterval(_timer)
      _timer = setInterval(buscar, INTERVALO)
      // a trava precisa reagir quando o modal abre/fecha
      setInterval(aplicarTrava, 1500)
    }
    tenta()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar)
  } else {
    iniciar()
  }
})()
