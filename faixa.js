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

  // 8 motivos (os 7 do app + "Ritmo lento", decisão 18/11)
  var MOTIVOS = [
    'Setup / troca de produto',
    'Manutenção',
    'Falta de material',
    'Qualidade / retrabalho',
    'Ajuste de processo',
    'Falta de operador',
    'Ritmo lento',
    'Outro',
  ]

  var _dados = null
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

  // Quem é o usuário logado (o Andon guarda o id em S.uid e o perfil em S.perfil)
  function eu() {
    try {
      var u = (typeof S !== 'undefined' && S) || null
      if (!u) return { id: '', email: '', nome: '' }
      var uid = String(u.uid || '')
      var perfil = u.perfil || null
      return {
        id: uid,
        email: String((perfil && perfil.email) || ''),
        nome: String((perfil && perfil.nome) || ''),
      }
    } catch (e) {
      return { id: '', email: '', nome: '' }
    }
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
    b.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:99990',
      'display:none',
      'background:#b91c1c',
      'color:#fff',
      'font-family:inherit',
      'box-shadow:0 4px 14px rgba(0,0,0,.35)',
      'max-height:62vh',
      'overflow:auto',
    ].join(';')
    document.body.appendChild(b)
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
      return
    }

    // Bloqueio POR FAIXA (correção 18/11): o Marcos é responsável só de
    // Montagem Curitiba — ele NÃO pode dispensar a faixa do Corte laser, mas
    // também não fica preso a ela. Cada linha decide sozinha.
    var bloqueia = visiveis.some(souResponsavel)
    var linhas = visiveis
      .slice(0, 12)
      .map(function (p) {
        var resp = (p.responsaveis || []).map(function (x) { return x.nome }).join(', ')
        var fundo = p.tipo === 'zero' ? '#7f1d1d' : '#9a3412'
        var rotulo = p.tipo === 'zero' ? 'SEM APONTAMENTO' : 'ABAIXO DA META'
        var realTxt = p.tipo === 'zero' ? '0' : String(p.produzido)
        return (
          '<div style="display:flex;align-items:center;gap:10px;padding:7px 12px;' +
          'background:' + fundo + ';border-radius:6px;margin:4px 0;flex-wrap:wrap">' +
          '<span style="background:rgba(255,255,255,.22);border-radius:4px;padding:2px 7px;' +
          'font-size:10.5px;font-weight:800;letter-spacing:.3px">' + rotulo + '</span>' +
          '<b style="font-size:12.5px">' + esc(p.celula_nome) + '</b>' +
          '<span style="opacity:.9;font-size:12px">' + esc(p.faixa_ini) + '–' + esc(p.faixa_fim) + '</span>' +
          '<span style="opacity:.8;font-size:11.5px">' + realTxt + ' / ' + p.meta + '</span>' +
          '<span style="flex:1"></span>' +
          (souResponsavel(p)
            ? '<button data-just="' + esc(chave(p)) + '" style="background:#fff;color:#991b1b;' +
              'border:0;border-radius:6px;padding:5px 12px;font-weight:800;font-size:12px;cursor:pointer">' +
              'Justificar</button>'
            : '<span style="font-size:11px;opacity:.85;margin-right:6px">' + esc(resp) + '</span>') +
          '</div>'
        )
      })
      .join('')

    var resto =
      visiveis.length > 12
        ? '<div style="padding:4px 12px;font-size:11.5px;opacity:.9">+ ' + (visiveis.length - 12) + ' outras faixas</div>'
        : ''

    var botaoDispensar = bloqueia
      ? '<span style="font-size:11.5px;opacity:.9">Você é responsável: só sai lançando</span>'
      : '<button id="faixaDispensar" style="background:rgba(255,255,255,.18);color:#fff;' +
        'border:1px solid rgba(255,255,255,.55);border-radius:6px;padding:6px 13px;' +
        'font-weight:700;font-size:12px;cursor:pointer">Dispensar</button>'

    b.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;padding:9px 14px 6px;flex-wrap:wrap">' +
      '  <span style="font-size:16px">⚠️</span>' +
      '  <b style="font-size:13.5px">' + visiveis.length +
      (visiveis.length === 1 ? ' faixa sem lançamento' : ' faixas sem lançamento') + '</b>' +
      '  <span style="flex:1"></span>' +
      botaoDispensar +
      '</div>' +
      '<div style="padding:0 10px 10px">' + linhas + resto + '</div>'

    b.style.display = 'block'
    piscar(bloqueia) // pisca só para quem não pode dispensar

    // liga os botões
    var botoes = b.querySelectorAll('[data-just]')
    for (var i = 0; i < botoes.length; i++) {
      botoes[i].onclick = (function (btn) {
        return function () {
          var k = btn.getAttribute('data-just')
          var alvo = null
          for (var j = 0; j < visiveis.length; j++) {
            if (chave(visiveis[j]) === k) { alvo = visiveis[j]; break }
          }
          if (alvo) abrirMotivos(alvo)
        }
      })(botoes[i])
    }

    var disp = document.getElementById('faixaDispensar')
    if (disp) {
      disp.onclick = function () {
        visiveis.forEach(function (p) { _dispensadas[chave(p)] = true })
        render()
      }
    }
  }

  // ── escolha do motivo: botões grandes, 1 toque ──────────────────────────────
  function abrirMotivos(p) {
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

    var subtitulo =
      p.tipo === 'zero'
        ? 'Não houve apontamento nesta faixa'
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
          salvar(p, btn.getAttribute('data-mot'), m)
        }
      })(opts[i])
    }
  }

  function salvar(p, motivo, modal) {
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
        // recarrega: a faixa justificada sai da lista
        buscar()
      })
      .catch(function (e) {
        if (modal) {
          var b = modal.querySelector('button[data-mot]')
          if (b) b.textContent = 'Erro: ' + e.message
        }
      })
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
    // espera o app existir (S.uid)
    var tentativas = 0
    function tenta() {
      try {
        if (typeof S === 'undefined' || !S || !S.uid) {
          if (++tentativas > 120) return // ~1 min e desiste
          return setTimeout(tenta, 500)
        }
      } catch (e) {
        if (++tentativas > 120) return
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
