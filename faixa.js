// ─────────────────────────────────────────────────────────────────────────────
// painel-faixa.js — ALERTA DE LANÇAMENTO PENDENTE POR FAIXA (T3, 18/11/2026)
//
// Pedido do diretor: "quando a pessoa não marca hora a hora, esse negócio fica
// piscando... e se foi zero, ela tem que colocar qual é o motivo da parada".
//
// REGRA (fechada com o André em 18/11):
//   - Faixa que JÁ TERMINOU (fim <= agora) e não teve apontamento -> pendente.
//   - Abaixo da meta também é pendente (qualquer valor abaixo).
//   - Célula só entra se estiver ATIVA no dia e tiver responsável.
//   - Montagem Vinhedo fica fora (sem responsável).
//   - TODOS veem o alerta. Só o NÃO responsável pode dispensar.
//   - Responsável: o alerta só sai lançando (o botão de dispensar não aparece).
//   - Acumulativo: mostra TODAS as faixas pendentes, não só a última.
//
// VIGÊNCIA: só vale a partir de 19/11/2026 (decisão do André — hoje não pode
// atrapalhar a produção em curso).
//
// FONTE DO DADO: GET /backend/v1/compass2/pendencias?data=AAAA-MM-DD
//   (rota criada na T2; devolve faixas pendentes já com responsáveis)
//
// Este arquivo NÃO altera nada existente: cria um elemento fixo no topo e usa
// os mesmos endpoints públicos. Se a rota falhar, o app segue normal.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict'

  var BANNER_ID = 'faixaPendBanner'
  var CORTE = '2026-11-19' // vigência (decisão André 18/11)
  var API = 'https://painel-entregas-semanais-708f0.shrd00.internal.goskip.dev'
  var INTERVALO = 60000 // 1 min: barato e suficiente para "hora virou"

  // 7 motivos (decisão 18/11). "Ritmo lento" fica de fora por enquanto:
  // ele serve para "abaixo da meta", que só entra na próxima etapa. Hoje o
  // alerta é apenas de faixa SEM lançamento.
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
  // POPUP (pedido André 18/11): dispara quando ENTRA UMA NOVA FAIXA (a hora
  // virou) e existe pendência. Não repete a mesma faixa: guarda a última que
  // já avisou, por máquina.
  var _ultimaFaixaAvisada = ''
  var _timer = null
  var _dispensadas = {} // por máquina: chave -> true

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function hoje() {
    var d = new Date(Date.now() - 10800000) // BRT
    var mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    var dd = String(d.getUTCDate()).padStart(2, '0')
    return d.getUTCFullYear() + '-' + mm + '-' + dd
  }

  function chave(p) {
    return p.dia + '|' + p.celula + '|' + p.faixa_ini + '|' + p.faixa_fim
  }

  // Quem é o usuário logado.
  // IMPORTANTE (correção 18/11): o app inteiro vive dentro de uma IIFE, então
  // `S` NÃO é global — o banner não consegue ler S.uid. A sessão, porém, fica
  // no localStorage (Supabase persiste ali). Lemos dela.
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

  // responsável = o e-mail do usuário está na lista daquela célula
  function souResponsavel(p) {
    var me = eu()
    if (!me.email) return false
    var lista = p.responsaveis || []
    for (var i = 0; i < lista.length; i++) {
      if (String(lista[i].email || '').toLowerCase() === me.email.toLowerCase()) return true
    }
    return false
  }

  function criar() {
    var b = document.getElementById(BANNER_ID)
    if (b) return b
    b = document.createElement('div')
    b.id = BANNER_ID
    // LAYOUT (correção 18/11): antes era position:fixed e tampava o menu
    // superior, impedindo a navegação para apontar. Agora entra no FLUXO da
    // página, logo após o <header>: empurra o conteúdo para baixo em vez de
    // cobrir. Nada do app é escondido.
    b.style.cssText = [
      'position:relative',
      'z-index:900',
      'display:none',
      'background:#b91c1c',
      'color:#fff',
      'font-family:inherit',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)',
    ].join(';')

    // procura o melhor ponto de inserção: depois do header do app
    var alvo = document.querySelector('header.top') || document.querySelector('header') || null
    if (alvo && alvo.parentNode) {
      alvo.parentNode.insertBefore(b, alvo.nextSibling)
    } else {
      // fallback: antes do primeiro irmão de conteúdo, nunca no fim do body
      var main = document.querySelector('main') || document.getElementById('view') || null
      if (main && main.parentNode) main.parentNode.insertBefore(b, main)
      else document.body.insertBefore(b, document.body.firstChild)
    }
    return b
  }

  // pisca a barra superior enquanto houver pendência do responsável
  var _pisca = null
  function piscar(ligar) {
    var b = document.getElementById(BANNER_ID)
    if (!b) return
    if (ligar) {
      if (_pisca) return
      var on = false
      _pisca = setInterval(function () {
        on = !on
        b.style.background = on ? '#dc2626' : '#b91c1c'
      }, 900)
    } else {
      if (_pisca) {
        clearInterval(_pisca)
        _pisca = null
      }
      b.style.background = '#b91c1c'
    }
  }

  function render() {
    var b = criar()
    var lista = (_dados && _dados.pendencias) || []

    // vigência: antes da data de corte não mostra nada
    if (hoje() < CORTE) {
      b.style.display = 'none'
      piscar(false)
      return
    }

    // tira as que esta máquina já dispensou (só vale para não responsável)
    var visiveis = lista.filter(function (p) {
      if (souResponsavel(p)) return true // responsável: nunca sai por dispensa
      return !_dispensadas[chave(p)]
    })

    if (!visiveis.length) {
      b.style.display = 'none'
      piscar(false)
      var velho = document.getElementById('faixaPainel')
      if (velho) velho.parentNode.removeChild(velho)
      return
    }

    // Bloqueio POR FAIXA: cada linha decide sozinha se eu posso dispensar.
    var bloqueia = visiveis.some(souResponsavel)

    // Banner GENÉRICO (pedido André 18/11): uma linha, sem listar tudo.
    // O detalhe só aparece ao clicar em "Ver".
    var botaoDispensar = bloqueia
      ? '<span style="font-size:11.5px;opacity:.92;background:rgba(255,255,255,.16);' +
        'padding:5px 10px;border-radius:6px">' +
        'Você responde por estas faixas — lance o apontamento ou marque o motivo' +
        '</span>'
      : '<button id="faixaDispensar" style="background:rgba(255,255,255,.18);color:#fff;' +
        'border:1px solid rgba(255,255,255,.55);border-radius:7px;padding:7px 14px;' +
        'font-weight:700;font-size:12.5px;cursor:pointer">Dispensar</button>'

    b.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;padding:10px 15px;flex-wrap:wrap">' +
      '  <span style="font-size:17px">⚠️</span>' +
      '  <b style="font-size:14px">' + visiveis.length +
      (visiveis.length === 1 ? ' faixa sem lançamento' : ' faixas sem lançamento') + '</b>' +
      '  <span style="flex:1;min-width:120px;opacity:.9;font-size:12.5px">' +
      'clique em Ver para saber quais' + '</span>' +
      '  <button id="faixaVer" style="background:#fff;color:#991b1b;border:0;border-radius:7px;' +
      'padding:7px 16px;font-weight:800;font-size:12.5px;cursor:pointer">Ver</button>' +
      botaoDispensar +
      '</div>'

    b.style.display = 'block'
    piscar(bloqueia) // pisca só para quem não pode dispensar

    var ver = document.getElementById('faixaVer')
    if (ver) ver.onclick = function () { abrirPainel(visiveis) }

    var disp = document.getElementById('faixaDispensar')
    if (disp) {
      disp.onclick = function () {
        visiveis.forEach(function (p) { _dispensadas[chave(p)] = true })
        render()
      }
    }

    // popup quando a hora virou e há pendência para quem responde
    talvezAvisar(visiveis)
  }

  // ── POPUP de faixa nova (pedido André 18/11) ───────────────────────────────
  // Aparece quando a hora vira e existe pendência para quem responde.
  // É um alerta, não um bloqueio: tem botão de fechar e o banner continua no topo.
  function abrirPopup(minhas, faixa) {
    var velho = document.getElementById('faixaPopup')
    if (velho) velho.parentNode.removeChild(velho)

    var m = document.createElement('div')
    m.id = 'faixaPopup'
    m.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99994',
      'background:rgba(0,0,0,.55)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:18px',
    ].join(';')

    var itens = minhas
      .slice(0, 10)
      .map(function (p) {
        return (
          '<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;' +
          'border-bottom:1px solid #e5e7eb">' +
          '  <span style="flex:1;font-size:13px;color:#111827"><b>' + esc(p.celula_nome) +
          '</b><span style="color:#6b7280"> · ' + esc(p.faixa_ini) + '–' + esc(p.faixa_fim) +
          '</span></span>' +
          '  <button data-pm="' + esc(chave(p)) + '" style="background:#991b1b;color:#fff;' +
          'border:0;border-radius:6px;padding:7px 12px;font-weight:800;font-size:12px;' +
          'cursor:pointer;white-space:nowrap">Informar motivo</button>' +
          '</div>'
        )
      })
      .join('')

    var resto =
      minhas.length > 10
        ? '<div style="padding:8px 12px;font-size:12px;color:#6b7280">+ ' +
          (minhas.length - 10) + ' outras</div>'
        : ''

    m.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:600px;width:100%;' +
      'font-family:inherit;max-height:88vh;display:flex;flex-direction:column;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.4)">' +
      '  <div style="padding:18px 20px 14px;border-bottom:1px solid #e5e7eb;' +
      'background:#fef2f2;border-radius:14px 14px 0 0">' +
      '    <div style="display:flex;align-items:center;gap:10px">' +
      '      <span style="font-size:22px">⚠️</span>' +
      '      <div>' +
      '        <div style="font-size:16px;font-weight:800;color:#991b1b">Nova faixa · ' +
      esc(faixa.replace('-', '–')) + '</div>' +
      '        <div style="font-size:12.5px;color:#7f1d1d;margin-top:2px">' +
      minhas.length + (minhas.length === 1 ? ' faixa sem apontamento' : ' faixas sem apontamento') +
      ' na sua célula</div>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '  <div style="overflow:auto">' + itens + resto + '</div>' +
      '  <div style="padding:12px 20px;text-align:right;border-top:1px solid #e5e7eb">' +
      '    <button id="faixaPopupOk" style="background:#f3f4f6;color:#374151;border:0;' +
      'border-radius:8px;padding:10px 20px;font-weight:700;font-size:13px;cursor:pointer">' +
      'Agora não</button>' +
      '  </div>' +
      '</div>'

    document.body.appendChild(m)

    document.getElementById('faixaPopupOk').onclick = function () {
      m.parentNode.removeChild(m)
    }

    var bs = m.querySelectorAll('[data-pm]')
    for (var i = 0; i < bs.length; i++) {
      bs[i].onclick = (function (btn) {
        return function () {
          var k = btn.getAttribute('data-pm')
          var alvo = null
          for (var j = 0; j < minhas.length; j++) {
            if (chave(minhas[j]) === k) { alvo = minhas[j]; break }
          }
          if (alvo) abrirMotivos(alvo, m)
        }
      })(bs[i])
    }
  }

  // ── painel com a LISTA de pendências (botão "Ver") ─────────────────────────
  function abrirPainel(visiveis) {
    var velho = document.getElementById('faixaPainel')
    if (velho) velho.parentNode.removeChild(velho)

    var m = document.createElement('div')
    m.id = 'faixaPainel'
    m.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99995',
      'background:rgba(0,0,0,.62)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:16px',
    ].join(';')

    // ORDENAÇÃO (pedido André 18/11): agrupar por FAIXA HORÁRIA, não por célula.
    // Dentro da mesma faixa, ordena pelo nome da célula.
    var ordenadas = visiveis.slice().sort(function (a, b) {
      var ta = String(a.faixa_ini || '')
      var tb = String(b.faixa_ini || '')
      if (ta !== tb) return ta < tb ? -1 : 1
      var na = String(a.celula_nome || '')
      var nb = String(b.celula_nome || '')
      return na < nb ? -1 : na > nb ? 1 : 0
    })

    // cabeçalho de faixa: aparece quando a faixa muda
    var faixaAtual = ''
    var linhas = ordenadas
      .map(function (p) {
        var resp = (p.responsaveis || []).map(function (x) { return x.nome }).join(', ')
        var acao = souResponsavel(p)
          ? '<button data-mot="' + esc(chave(p)) + '" style="background:#991b1b;color:#fff;' +
            'border:0;border-radius:7px;padding:8px 14px;font-weight:800;font-size:12.5px;' +
            'cursor:pointer;white-space:nowrap">Informar motivo</button>'
          : '<span style="font-size:11.5px;color:#6b7280;white-space:nowrap">' +
            esc(resp || 'sem responsável') + '</span>'
        var cab = ''
        if (p.faixa_ini !== faixaAtual) {
          faixaAtual = p.faixa_ini
          cab =
            '<div style="background:#f3f4f6;padding:8px 14px;font-weight:800;' +
            'font-size:12.5px;color:#374151;letter-spacing:.3px;' +
            'border-top:1px solid #e5e7eb">' +
            esc(p.faixa_ini) + '–' + esc(p.faixa_fim) +
            '</div>'
        }
        return (
          cab +
          '<div style="display:flex;align-items:center;gap:12px;padding:11px 13px;' +
          'border-bottom:1px solid #e5e7eb;flex-wrap:wrap">' +
          '  <div style="flex:1;min-width:180px">' +
          '    <div style="font-weight:800;font-size:13.5px;color:#111827">' + esc(p.celula_nome) + '</div>' +
          '    <div style="font-size:12px;color:#6b7280">programado ' + p.meta +
          ' un  ·  lançado 0</div>' +
          '  </div>' +
          acao +
          '</div>'
        )
      })
      .join('')

    m.innerHTML =
      '<div style="background:#fff;border-radius:12px;max-width:620px;width:100%;' +
      'font-family:inherit;max-height:86vh;display:flex;flex-direction:column">' +
      '  <div style="padding:16px 18px 12px;border-bottom:1px solid #e5e7eb">' +
      '    <h3 style="margin:0;font-size:17px;color:#111827">Faixas sem lançamento</h3>' +
      '    <div style="color:#6b7280;font-size:12.5px;margin-top:3px">' +
      visiveis.length + (visiveis.length === 1 ? ' faixa pendente' : ' faixas pendentes') +
      '  ·  dia ' + esc(hoje().split('-').reverse().join('/')) + '</div>' +
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
          for (var j = 0; j < visiveis.length; j++) {
            if (chave(visiveis[j]) === k) { alvo = visiveis[j]; break }
          }
          if (alvo) abrirMotivos(alvo, m)
        }
      })(botoes[i])
    }
  }

  // ── escolha do motivo: botões grandes, 1 toque ──────────────────────────────
  function abrirMotivos(p, painelPai) {
    var velho = document.getElementById('faixaMotivos')
    if (velho) velho.parentNode.removeChild(velho)

    var m = document.createElement('div')
    m.id = 'faixaMotivos'
    m.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99995',
      'background:rgba(0,0,0,.62)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:16px',
    ].join(';')

    var botoes = MOTIVOS.map(function (mot) {
      return (
        '<button data-mot="' + esc(mot) + '" style="background:#fff;color:#111827;' +
        'border:1px solid #d1d5db;border-radius:8px;padding:14px 12px;font-size:13.5px;' +
        'font-weight:700;cursor:pointer;text-align:left">' + esc(mot) + '</button>'
      )
    }).join('')

    // Hoje o alerta é só de faixa SEM lançamento (regra 18/11). O texto de
    // "abaixo da meta" fica pronto para quando essa etapa for ligada.
    var subtitulo =
      p.tipo === 'zero'
        ? 'Nenhum lançamento nesta faixa — informe o motivo'
        : 'Produziu ' + p.produzido + ' de ' + p.meta + ' (abaixo da meta)'

    m.innerHTML =
      '<div style="background:#fff;border-radius:12px;max-width:560px;width:100%;' +
      'padding:18px;font-family:inherit;max-height:88vh;overflow:auto">' +
      '  <div style="font-size:12px;color:#6b7280;font-weight:700;letter-spacing:.4px">' +
      esc(p.celula_nome).toUpperCase() + ' · ' + esc(p.faixa_ini) + '–' + esc(p.faixa_fim) + '</div>' +
      '  <h3 style="margin:6px 0 2px;font-size:17px;color:#111827">Qual o motivo?</h3>' +
      '  <div style="color:#6b7280;font-size:12.5px;margin-bottom:14px">' + subtitulo + '</div>' +
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
      unidade: '',
      faixa_ini: p.faixa_ini,
      faixa_fim: p.faixa_fim,
      faixa_idx: p.faixa_idx,
      motivo: motivo,
      obs: '',
      tipo: p.tipo,
      qtd_apontada: p.produzido,
      meta_faixa: p.meta,
      quem: me.nome,
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
        // recarrega: a faixa marcada sai da lista
        buscar()
      })
      .catch(function (e) {
        if (modal) {
          var b = modal.querySelector('button[data-mot]')
          if (b) b.textContent = 'Erro: ' + e.message
        }
      })
  }

  // Qual faixa está correndo agora (a primeira cujo fim ainda não passou).
  // Serve para saber quando "a hora virou".
  function faixasDoDia() {
    return (_dados && _dados.faixas) || []
  }

  function faixaCorrente() {
    var lista = faixasDoDia()
    var d = new Date(Date.now() - 10800000)
    var agora = d.getUTCHours() * 60 + d.getUTCMinutes()
    function toMin(t) {
      var p = String(t || '').split(':')
      if (p.length < 2) return NaN
      return parseInt(p[0], 10) * 60 + parseInt(p[1], 10)
    }
    for (var i = 0; i < lista.length; i++) {
      var ini = toMin(lista[i].ini)
      var fim = toMin(lista[i].fim)
      if (isNaN(ini) || isNaN(fim)) continue
      if (agora >= ini && agora < fim) return String(lista[i].ini) + '-' + String(lista[i].fim)
    }
    return ''
  }

  // marca d'água da faixa: muda quando a hora vira
  function chaveDaFaixaAtual() {
    var fc = faixaCorrente()
    if (fc) return fc
    // fora de qualquer faixa (almoço/fim do dia): usa a hora cheia
    var d = new Date(Date.now() - 10800000)
    return 'h' + d.getUTCHours()
  }

  // O popup só avisa até as 17h (decisão André 18/11): depois disso não há mais
  // o que corrigir no dia. O BANNER continua aparecendo o tempo todo.
  var LIMITE_POPUP_MIN = 17 * 60

  function talvezAvisar(visiveis) {
    if (!visiveis || !visiveis.length) return
    // fora do horário de aviso: só marca como visto, sem abrir popup
    var agoraD = new Date(Date.now() - 10800000)
    if (agoraD.getUTCHours() * 60 + agoraD.getUTCMinutes() >= LIMITE_POPUP_MIN) {
      _ultimaFaixaAvisada = chaveDaFaixaAtual()
      return
    }
    var faixa = chaveDaFaixaAtual()
    if (!faixa) return
    if (_ultimaFaixaAvisada === faixa) return // já avisou nesta faixa
    // só avisa quem tem pendência a resolver (responsável)
    var minhas = visiveis.filter(souResponsavel)
    if (!minhas.length) {
      _ultimaFaixaAvisada = faixa
      return
    }
    _ultimaFaixaAvisada = faixa
    abrirPopup(minhas, faixa)
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
        render()
      })
      .catch(function () {
        // silencioso: o alerta nunca pode atrapalhar o Andon
      })
  }

  function iniciar() {
    // Espera haver sessão (o app já logou). Não dependemos de `S`: ele é local
    // à IIFE do app. A sessão aparece no localStorage quando o login acontece.
    var tentativas = 0
    function tenta() {
      var s = lerSessao()
      if (!s) {
        if (++tentativas > 240) return // ~2 min: desiste sem atrapalhar
        return setTimeout(tenta, 500)
      }
      buscar()
      if (_timer) clearInterval(_timer)
      _timer = setInterval(buscar, INTERVALO)
    }
    tenta()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar)
  } else {
    iniciar()
  }
})()
