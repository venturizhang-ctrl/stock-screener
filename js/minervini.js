/**
 * minervini.js — Mark Minervini SEPA策略 A股适配版
 *
 * 三阶段筛选：
 * 阶段1（趋势模板）：8项条件过滤，确认第二阶段上升趋势
 * 阶段2（VCP检测）：波动收缩形态 —— 三轮收缩 + 量缩
 * 阶段3（入场信号）：今日放量突破VCP高点
 *
 * A股适配：
 * - 均线体系：50/150/200 SMA 保持不变（A股交易天数足够）
 * - RS评级：以60日涨幅绝对值替代（≥10%视为RS>70）
 * - VCP：三底逐步抬高 + 每轮振幅递减 + 成交量递减
 */

(function() {

    updateMarketStatus();

    // ===== 可调参数 =====
    var trendTemplateMin = 7;   // 趋势模板最少通过条数（默认7/8）
    var vcpMinBases = 2;        // VCP最少底部数（2或3）
    var vcpLookback = 70;       // VCP扫描区间（根K线）
    var changeMin = 1.0;        // 今日涨幅下限
    var rsMinReturn = 10;       // RS替代：60日最低涨幅%
    var volExpandMin = 1.5;     // 突破放量倍数

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    // ===== 参数调整 =====
    (function() {
        var el = document.getElementById('optTpl7');
        if (el) el.addEventListener('change', function() { if (this.checked) trendTemplateMin = 7; });
        el = document.getElementById('optTpl8');
        if (el) el.addEventListener('change', function() { if (this.checked) trendTemplateMin = 8; });
        el = document.getElementById('optVcp2');
        if (el) el.addEventListener('change', function() { if (this.checked) vcpMinBases = 2; });
        el = document.getElementById('optVcp3');
        if (el) el.addEventListener('change', function() { if (this.checked) vcpMinBases = 3; });
        var chgOptions = [
            { id: 'optChg1', val: 1 },
            { id: 'optChg2', val: 2 },
            { id: 'optChg3', val: 3 },
            { id: 'optChg5', val: 5 }
        ];
        chgOptions.forEach(function(opt) {
            var e = document.getElementById(opt.id);
            if (e) e.addEventListener('change', function() { if (this.checked) changeMin = opt.val; });
        });
    })();

    // ===== SMA 计算 =====
    function calcSMA(bars, period) {
        if (bars.length < period) return [];
        var sma = [];
        for (var i = 0; i < bars.length; i++) {
            if (i < period - 1) { sma.push(null); continue; }
            var sum = 0;
            for (var j = i - period + 1; j <= i; j++) sum += bars[j].close;
            sma.push(sum / period);
        }
        return sma;
    }

    // ===== 日K线（250根，覆盖年线）=====
    function fetchDailyKline250(code) {
        return new Promise(function(resolve, reject) {
            var c = code.toString();
            var symbol = (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
            var cb = 'dmv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

            var timer = setTimeout(function() {
                cleanup();
                reject(new Error('超时'));
            }, 12000);

            function cleanup() {
                clearTimeout(timer);
                delete window[cb];
                if (script && script.parentNode) script.parentNode.removeChild(script);
            }

            window[cb] = function(data) {
                cleanup();
                try {
                    if (!data || !Array.isArray(data)) { reject(new Error('无数据')); return; }
                    var bars = [];
                    for (var i = 0; i < data.length; i++) {
                        var bar = data[i];
                        var date = bar.day.split(' ')[0];
                        bars.push({
                            date: date,
                            open: parseFloat(bar.open) || 0,
                            close: parseFloat(bar.close) || 0,
                            high: parseFloat(bar.high) || 0,
                            low: parseFloat(bar.low) || 0,
                            volume: parseFloat(bar.volume) || 0
                        });
                    }
                    resolve(bars);
                } catch (e) { reject(e); }
            };

            var script = document.createElement('script');
            script.src = 'https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/' +
                cb + '/CN_MarketData.getKLineData?symbol=' + symbol +
                '&scale=240&ma=no&datalen=250';
            script.onerror = function() { cleanup(); reject(new Error('网络错误')); };
            document.body.appendChild(script);
        });
    }

    // ===== 阶段1：趋势模板（8条件）=====
    function checkTrendTemplate(dailyBars, opts) {
        opts = opts || {};
        var minPass = opts.minPass || 7;

        var result = {
            pass: false,
            passed: 0,
            total: 8,
            checks: {},
            details: []
        };

        if (!dailyBars || dailyBars.length < 200) {
            result.details.push('日K线不足200条，无法计算年线');
            return result;
        }

        var len = dailyBars.length;
        var close = dailyBars[len - 1].close;

        // 计算均线
        var sma50 = calcSMA(dailyBars, 50);
        var sma150 = calcSMA(dailyBars, 150);
        var sma200 = calcSMA(dailyBars, 200);

        var v50 = sma50[len - 1];
        var v150 = sma150[len - 1];
        var v200 = sma200[len - 1];

        // 250日高低（约52周）
        var high250 = -Infinity, low250 = Infinity;
        var lookback250 = Math.min(250, len);
        for (var i = len - lookback250; i < len; i++) {
            if (dailyBars[i].high > high250) high250 = dailyBars[i].high;
            if (dailyBars[i].low < low250) low250 = dailyBars[i].low;
        }

        // 60日涨幅（RS替代）
        var idx60 = Math.max(0, len - 60);
        var ret60 = (close - dailyBars[idx60].close) / dailyBars[idx60].close * 100;

        // ---- 8项检查 ----
        var c = {};

        // ① 股价 > 150MA 且 > 200MA
        c.c1 = v150 !== null && v200 !== null && close > v150 && close > v200;
        // ② 150MA > 200MA
        c.c2 = v150 !== null && v200 !== null && v150 > v200;
        // ③ 200MA 上升 ≥1个月（20个交易日）
        var v200_20ago = sma200[len - 21];
        c.c3 = v200 !== null && v200_20ago !== null && v200 > v200_20ago;
        // ④ 50MA > 150MA 且 > 200MA
        c.c4 = v50 !== null && v150 !== null && v200 !== null && v50 > v150 && v50 > v200;
        // ⑤ 股价 > 50MA
        c.c5 = v50 !== null && close > v50;
        // ⑥ 股价比250日低点高出 ≥25%
        c.c6 = low250 < Infinity && (close - low250) / low250 * 100 >= 25;
        // ⑦ 股价距250日高点 ≤25%
        c.c7 = high250 > 0 && close >= high250 * 0.75;
        // ⑧ RS替代：60日涨幅 ≥ 阈值
        c.c8 = ret60 >= (opts.rsMinReturn || 10);

        result.checks = c;

        var labels = [
            '①价>150&200MA', '②150MA>200MA', '③200MA上升1月', '④50MA>150&200MA',
            '⑤价>50MA', '⑥距年低+25%', '⑦距年高≤25%', '⑧60日涨≥' + (opts.rsMinReturn||10) + '%'
        ];
        var keys = ['c1','c2','c3','c4','c5','c6','c7','c8'];
        var passCount = 0;

        for (var k = 0; k < keys.length; k++) {
            if (c[keys[k]]) passCount++;
        }

        result.passed = passCount;
        result.pass = passCount >= minPass;

        // 数据快照
        result.snapshot = {
            close: close,
            sma50: v50, sma150: v150, sma200: v200,
            high250: high250, low250: low250,
            ret60: ret60,
            fromYearLow: low250 < Infinity ? ((close - low250) / low250 * 100) : null,
            fromYearHigh: high250 > 0 ? ((close - high250) / high250 * 100) : null
        };

        // 生成详情
        for (var k2 = 0; k2 < keys.length; k2++) {
            var mark = c[keys[k2]] ? ' ✓' : ' ✗';
            result.details.push(mark + ' ' + labels[k2]);
        }
        result.details.push((result.pass ? '✓' : '✗') + ' 通过' + passCount + '/' + minPass);

        return result;
    }

    // ===== 阶段2：VCP波动收缩检测 =====
    function detectVCP(dailyBars, opts) {
        opts = opts || {};
        var minBases = opts.minBases || 2;
        var lookback = opts.lookback || 70;

        var result = {
            found: false,
            bases: [],
            quality: 0,  // 0-100
            details: []
        };

        if (dailyBars.length < lookback) {
            result.details.push('K线不足' + lookback + '条');
            return result;
        }

        var len = dailyBars.length;
        var startIdx = len - lookback;

        // 找局部低点（5天窗口）
        var troughs = [];
        for (var i = startIdx + 3; i < len - 3; i++) {
            var bar = dailyBars[i];
            var isTrough = true;
            for (var j = i - 3; j <= i + 3; j++) {
                if (j === i) continue;
                if (dailyBars[j].low <= bar.low) { isTrough = false; break; }
            }
            if (isTrough) {
                troughs.push({
                    idx: i,
                    date: bar.date,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume
                });
            }
        }

        if (troughs.length < minBases) {
            result.details.push('VCP底部不足: 仅' + troughs.length + '个 < ' + minBases);
            return result;
        }

        // 取最后N个底部
        var recentTroughs = troughs.slice(-(minBases + 1)); // 多取1个做参考判断
        if (recentTroughs.length < minBases) {
            result.details.push('近期底部不足');
            return result;
        }

        // 检查：底部逐步抬高
        var bases = [];
        for (var t = 0; t < recentTroughs.length - 1; t++) {
            var cur = recentTroughs[t];
            var nxt = recentTroughs[t + 1];
            if (nxt.low <= cur.low) {
                result.details.push('底部未抬高: ' + nxt.date + ' ≤ ' + cur.date);
                return result;
            }
            bases.push({
                date: cur.date,
                low: cur.low,
                idx: cur.idx
            });
        }
        // 加入最后一个
        bases.push({
            date: recentTroughs[recentTroughs.length - 1].date,
            low: recentTroughs[recentTroughs.length - 1].low,
            idx: recentTroughs[recentTroughs.length - 1].idx
        });

        if (bases.length < minBases) {
            result.details.push('有效底部不足');
            return result;
        }

        // 检查每轮反弹后回落的幅度是否递减（核心VCP特征）
        var pullbacks = [];
        for (var b = 0; b < bases.length; b++) {
            var baseIdx = bases[b].idx;
            // 找这个底部之前的局部高点
            var prevHigh = -Infinity;
            var searchStart = b === 0 ? startIdx : bases[b - 1].idx + 1;
            for (var h = searchStart; h <= baseIdx; h++) {
                if (dailyBars[h].high > prevHigh) prevHigh = dailyBars[h].high;
            }
            var pullbackPct = prevHigh > 0 ? (prevHigh - bases[b].low) / prevHigh * 100 : 0;
            pullbacks.push({ pct: pullbackPct, high: prevHigh, low: bases[b].low });
        }

        // 检查回落幅度是否递减
        var contracting = true;
        var contractCount = 0;
        for (var p = 0; p < pullbacks.length - 1; p++) {
            if (pullbacks[p + 1].pct <= pullbacks[p].pct * 1.05) { // 允许5%容差
                contractCount++;
            }
        }
        if (contractCount < pullbacks.length - 1) {
            // 不是完美的递减，但仍可能有效
            result.details.push('△ VCP收缩不完美(' + contractCount + '/' + (pullbacks.length-1) + '轮递减)');
        } else {
            result.details.push('✓ VCP完美收缩');
        }

        // 检查成交量是否在VCP过程中递减
        var volContracting = true;
        for (var b2 = 1; b2 < bases.length; b2++) {
            var volPrev = dailyBars[bases[b2 - 1].idx].volume;
            var volCur = dailyBars[bases[b2].idx].volume;
            if (volCur > volPrev * 1.2) { volContracting = false; break; }
        }

        result.found = true;
        result.bases = bases;
        result.pullbacks = pullbacks;
        result.vcpHigh = pullbacks[pullbacks.length - 1].high; // 最近一个反弹高点 = 突破位
        result.contractCount = contractCount;
        result.volContracting = volContracting;

        // 质量评分
        var quality = 50;
        if (bases.length >= 3) quality += 15;
        if (contractCount >= pullbacks.length - 1) quality += 15;
        if (volContracting) quality += 10;
        if (pullbacks.length > 0 && pullbacks[pullbacks.length - 1].pct < 10) quality += 10;
        result.quality = Math.min(100, quality);

        result.details.push('VCP底部' + bases.length + '个 收缩' + contractCount + '轮 量缩' + (volContracting?'是':'否') + ' 质量' + result.quality);

        return result;
    }

    // ===== 阶段3：入场信号 =====
    function checkEntry(dailyBars, today, vcpResult, opts) {
        opts = opts || {};
        var volMin = opts.volExpandMin || 1.5;

        var result = {
            signal: false,
            breakVcp: false,
            volExpand: false,
            closeStrong: false,
            breakPct: 0,
            volRatio: 0,
            details: []
        };

        var todayHigh = today.high || today.price;
        var todayPrice = today.price;
        var todayVol = today.volume;

        // 突破VCP高点
        var vcpHigh = vcpResult.vcpHigh;
        if (todayHigh > vcpHigh) {
            result.breakVcp = true;
            result.breakPct = (todayHigh - vcpHigh) / vcpHigh * 100;
            result.details.push('✓ 突破VCP高点! +' + result.breakPct.toFixed(2) + '%');
        } else {
            result.details.push('✗ 未突破VCP高点 ' + todayHigh.toFixed(2) + ' ≤ ' + vcpHigh.toFixed(2));
            return result;
        }

        // 放量（对比最近10日均量）
        var len = dailyBars.length;
        var sumVol10 = 0;
        for (var i = len - 11; i < len - 1; i++) {
            if (i >= 0) sumVol10 += dailyBars[i].volume;
        }
        var avgVol10 = sumVol10 / 10;
        if (todayVol > 0 && avgVol10 > 0) {
            result.volRatio = todayVol / avgVol10;
            if (result.volRatio >= volMin) {
                result.volExpand = true;
                result.details.push('✓ 放量 ×' + result.volRatio.toFixed(2));
            } else {
                result.details.push('△ 量比不足 ×' + result.volRatio.toFixed(2) + ' < ' + volMin);
            }
        }

        // 收盘强势
        var closePct = todayHigh > 0 ? todayPrice / todayHigh : 0;
        if (closePct >= 0.88) {
            result.closeStrong = true;
            result.details.push('✓ 收盘强势 ' + (closePct*100).toFixed(0) + '%');
        } else {
            result.details.push('△ 收盘偏弱 ' + (closePct*100).toFixed(0) + '%');
        }

        result.signal = result.breakVcp && (result.volExpand || result.closeStrong);
        if (result.signal) result.details.push('★★★ SEPA入场信号确认！');

        return result;
    }

    // ===== 主流程 =====
    document.getElementById('btnRefresh').addEventListener('click', runScreening);

    async function runScreening() {
        clearResults();

        if (!isTradingTime()) {
            var status = getMarketStatus();
            var ok = await myConfirm('当前' + status.text + '。实时筛选需交易时段，是否仍用最近收盘数据尝试？');
            if (!ok) return;
        }

        hideError(); setRefreshButton(true);
        debugLines = [];
        debugLog('=== Mark Minervini SEPA 选股 ===');
        debugLog('趋势模板: ' + trendTemplateMin + '/8 | VCP: ≥' + vcpMinBases + '底 | 涨幅≥' + changeMin + '% | 60日RS≥' + rsMinReturn + '%');
        debugLog('时间: ' + new Date().toLocaleTimeString());
        debugLog('');

        try {
            // ===== 阶段1：海选 =====
            showLoading('海选涨幅榜...', '涨幅≥' + changeMin + '%');
            var candidates = await getRisingStocks(debugLog, changeMin);
            debugLog('阶段1 候选: ' + candidates.length + '只');

            if (candidates.length === 0) {
                debugLog('无候选，停止');
                showResults([]);
                finishRefresh();
                return;
            }

            // ===== 阶段2：趋势模板 + VCP =====
            showLoading('验证趋势模板...', '候选' + candidates.length + '只，拉取250日K线');
            var finalStocks = [];
            var batchSize = 2; // 250根K线大请求，保守并发
            var processed = 0, errors = 0;
            var tplPassed = 0, vcpFound = 0;

            for (var bi = 0; bi < candidates.length; bi += batchSize) {
                var batch = candidates.slice(bi, bi + batchSize);

                var promises = batch.map(function(stock) {
                    return fetchDailyKline250(stock.code).then(function(bars) {
                        return { stock: stock, bars: bars, error: null };
                    }).catch(function(e) {
                        return { stock: stock, bars: [], error: e.message };
                    });
                });

                var results = await Promise.all(promises);

                for (var ri = 0; ri < results.length; ri++) {
                    var r = results[ri];
                    if (r.error || r.bars.length < 200) {
                        if (r.error) errors++;
                        processed++;
                        continue;
                    }

                    // 趋势模板
                    var tpl = checkTrendTemplate(r.bars, {
                        minPass: trendTemplateMin,
                        rsMinReturn: rsMinReturn
                    });

                    if (!tpl.pass) { processed++; continue; }
                    tplPassed++;

                    // VCP检测
                    var vcp = detectVCP(r.bars, {
                        minBases: vcpMinBases,
                        lookback: vcpLookback
                    });

                    if (!vcp.found) { processed++; continue; }
                    vcpFound++;

                    // 入场信号
                    var today = {
                        price: r.stock.price,
                        high: r.stock.high,
                        low: r.stock.low,
                        open: r.stock.open,
                        volume: r.stock.volume,
                        turnover: r.stock.turnover
                    };

                    var entry = checkEntry(r.bars, today, vcp, {
                        volExpandMin: volExpandMin
                    });

                    if (entry.signal) {
                        finalStocks.push({
                            code: r.stock.code,
                            name: r.stock.name,
                            price: r.stock.price,
                            change: r.stock.change,
                            turnover: r.stock.turnover,
                            nmc: r.stock.nmc,
                            tplResult: tpl,
                            vcpResult: vcp,
                            entryResult: entry
                        });
                    }
                    processed++;
                }

                var pct = Math.round(processed / candidates.length * 100);
                showLoading('验证SEPA...',
                    processed + '/' + candidates.length + ' (' + pct + '%) ' +
                    '模板' + tplPassed + ' VCP' + vcpFound + ' 信号' + finalStocks.length);

                if (bi + batchSize < candidates.length) await delay(500);
            }

            debugLog('');
            debugLog('=== 完成 ===');
            debugLog('候选:' + candidates.length + ' | 模板通过:' + tplPassed + ' | VCP发现:' + vcpFound + ' | 最终信号:' + finalStocks.length + ' | 错误:' + errors);

            if (finalStocks.length > 0) {
                debugLog('');
                finalStocks.forEach(function(s, idx) {
                    debugLog('【' + (idx+1) + '】' + s.code + ' ' + s.name + ' +' + s.change.toFixed(2) + '%');
                    debugLog('  [模板' + s.tplResult.passed + '/8]');
                    s.tplResult.details.forEach(function(d) { debugLog('    ' + d); });
                    debugLog('  [VCP] ' + s.vcpResult.details.join(' | '));
                    debugLog('  [入场] ' + s.entryResult.details.join(' | '));
                });
            } else {
                debugLog('无SEPA信号。建议：放宽趋势模板(7/8)、降低VCP底部数(2)、降低涨幅下限(1%)');
            }

            showResults(finalStocks);
            finishRefresh();

        } catch (e) {
            debugLog('!! ' + (e.message || e));
            showError(e.message || '筛选失败');
            setRefreshButton(false);
            hideLoading();
        }
    }

    // ===== UI =====
    function clearResults() {
        showResultSection('resultArea', false);
        document.getElementById('listResult').innerHTML = '';
        document.getElementById('countResult').textContent = '0';
    }

    function showResults(stocks) {
        showResultSection('resultArea', true);
        updateResultCount('countResult', stocks.length);
        document.getElementById('resultBadge').textContent = 'SEPA信号';
        renderSEPAList('listResult', stocks);
    }

    function renderSEPAList(containerId, stocks) {
        var container = document.getElementById(containerId);
        if (!stocks || stocks.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px"><p class="empty-text">无SEPA入场信号</p><p class="empty-hint">趋势模板 + VCP收缩 + 放量突破，三个条件同时满足极少见</p></div>';
            return;
        }

        var html = '';
        stocks.forEach(function(s) {
            var tpl = s.tplResult;
            var vcp = s.vcpResult;
            var ent = s.entryResult;
            var snap = tpl.snapshot;
            var mktCapYi = s.nmc ? (s.nmc / 100000000).toFixed(0) : '--';

            // 8条件小方块
            var checksHtml = '';
            var keys = ['c1','c2','c3','c4','c5','c6','c7','c8'];
            keys.forEach(function(k) {
                checksHtml += '<span class="sepa-check' + (tpl.checks[k] ? ' pass' : ' fail') + '"></span>';
            });

            html += '<div class="stock-card" style="border-left:3px solid #4A90D9;">' +
                '<div class="stock-card-header">' +
                    '<div><span class="stock-code">' + s.code + '</span>' +
                    '<span class="stock-name">' + s.name + '</span></div>' +
                    '<span class="stock-change up">+' + s.change.toFixed(2) + '%</span>' +
                '</div>' +
                '<div class="stock-details">' +
                    '<div class="detail-item"><span class="detail-label">现价</span><span class="detail-value">' + s.price.toFixed(2) + '</span></div>' +
                    '<div class="detail-item"><span class="detail-label">换手率</span><span class="detail-value">' + s.turnover.toFixed(2) + '%</span></div>' +
                    '<div class="detail-item"><span class="detail-label">流通市值</span><span class="detail-value">' + mktCapYi + '亿</span></div>' +
                '</div>' +
                // 趋势模板8格
                '<div class="sepa-row">' +
                    '<span class="sepa-label">趋势模板 ' + tpl.passed + '/8</span>' +
                    '<span class="sepa-checks">' + checksHtml + '</span>' +
                '</div>' +
                // VCP信息
                '<div class="flag-path">' +
                    '<span class="flag-step">📐 趋势模板</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step">📉 VCP ' + vcp.bases.length + '底</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step fire">🎯 突破 +' + ent.breakPct.toFixed(2) + '%</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">均线</span>' +
                    '<span class="flag-val">50MA ' + (snap.sma50 ? snap.sma50.toFixed(2) : '--') + ' | 150MA ' + (snap.sma150 ? snap.sma150.toFixed(2) : '--') + ' | 200MA ' + (snap.sma200 ? snap.sma200.toFixed(2) : '--') + '</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">年距</span>' +
                    '<span class="flag-val">距低点+' + (snap.fromYearLow ? snap.fromYearLow.toFixed(1) : '--') + '% | 距高点' + (snap.fromYearHigh ? snap.fromYearHigh.toFixed(1) : '--') + '% | 60日+' + (snap.ret60 ? snap.ret60.toFixed(1) : '--') + '%</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">VCP</span>' +
                    '<span class="flag-val">质量' + vcp.quality + ' | ' + vcp.details.join(' | ') + '</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">入场</span>' +
                    '<span class="flag-val">' + ent.details.join(' | ') + '</span>' +
                '</div>' +
            '</div>';
        });
        container.innerHTML = html;
    }

    function finishRefresh() {
        hideLoading(); setRefreshButton(false);
        var now = new Date();
        var ts = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
        updateLastRefresh(ts); updateMarketStatus();
    }

})();
