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
    _eu = {
      id: String((s.user && s.user.id) || ''),
      email: email,
      nome: email.split('@')[0],
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

  // A faixa 'ini' desta unidade está bloqueada?
  function faixaBloqueada(unidade, faixaIni) {
    if (!_bloqueio) return null
    var b = _bloqueio[String(unidade || 'C')]
    if (!b) return null
    // bloqueia da faixa pendente em diante
    if (String(faixaIni) >= String(b.faixa_ini)) return b
    return null
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

    // agrupa por unidade para mostrar o bloqueio de cada uma
    var unidades = {}
    for (var i = 0; i < lista.length; i++) {
      var u = String(lista[i].unidade || 'C')
      unidades[u] = (unidades[u] || 0) + 1
    }
    var resumo = Object.keys(unidades).map(function (uu) {
      return (uu === 'V' ? 'Vinhedo' : 'Curitiba') + ': ' + unidades[uu]
    }).join(' · ')

    b.style.background = '#b91c1c'
    b.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;padding:10px 15px;flex-wrap:wrap">' +
      '  <span style="font-size:17px">🔒</span>' +
      '  <b style="font-size:14px">' + lista.length +
      (lista.length === 1 ? ' faixa bloqueada' : ' faixas bloqueadas') + '</b>' +
      '  <span style="flex:1;min-width:140px;opacity:.92;font-size:12.5px">' +
      esc(resumo) + ' — lance ou justifique para liberar</span>' +
      '  <button id="faixaVer" style="background:#fff;color:#991b1b;border:0;border-radius:7px;' +
      'padding:7px 16px;font-weight:800;font-size:12.5px;cursor:pointer">Ver e resolver</button>' +
      '</div>'

    b.style.display = 'block'
    piscar(true)

    var ver = document.getElementById('faixaVer')
    if (ver) ver.onclick = function () { abrirPainel(lista) }
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
      return cab +
        '<div style="display:flex;align-items:center;gap:12px;padding:11px 13px;' +
        'border-bottom:1px solid #e5e7eb;flex-wrap:wrap">' +
        '  <div style="flex:1;min-width:170px">' +
        '    <div style="font-weight:800;font-size:13.5px;color:#111827">' + esc(p.celula_nome) + '</div>' +
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
      'O lançamento só libera quando todas estiverem justificadas · dia ' +
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

      // unidade: o app tem URLs '#apontar-<cel>' e a célula sabe a unidade.
      var un = 'C'
      try {
        var h = String(location.hash || '')
        var mm = /apontar-([A-Za-z0-9]+)/.exec(h)
        if (mm) {
          // células de Vinhedo conhecidas
          if (mm[1] === 'CCNTI3') un = 'V'
        }
      } catch (e0) {}

      if (!iniFaixa) return // não conseguimos ler: não bloqueia

      var b = faixaBloqueada(un, iniFaixa)
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

            // unidade pela célula aberta (Vinhedo = CCNTI3)
            var un = 'C'
            try {
              var hh2 = String(location.hash || '')
              var mm2 = /apontar-([A-Za-z0-9]+)/.exec(hh2)
              if (mm2 && mm2[1] === 'CCNTI3') un = 'V'
            } catch (e0) {}

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
      window.__faixaTravaLancamento = true
    } catch (e) {}
  }

  function buscar() {
    if (hoje() < CORTE) return
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
