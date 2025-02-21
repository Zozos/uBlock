/*******************************************************************************

    µBlock - a browser extension to block requests.
    Copyright (C) 2014 Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* global punycode, vAPI, uDom */

/******************************************************************************/

(function() {

'use strict';

/******************************************************************************/

// Ensure the popup is properly sized as soon as possible. It is assume the DOM
// content is ready at this point, which should be the case given where this
// script file is included in the HTML file.

var dfPaneVisibleStored = vAPI.localStorage.getItem('popupFirewallPane') === 'true';

// Hacky? I couldn't figure a CSS recipe for this problem.
// I do not want the left pane -- optional and hidden by defaut -- to
// dictate the height of the popup. The right pane dictates the height
// of the popup, and the left pane will have a scrollbar if ever its
// height is more than what is available.
(function() {
    var rpane = document.querySelector('#panes > div:nth-of-type(1)');
    if ( typeof rpane.offsetHeight === 'number' ) {
        document.querySelector('#panes > div:nth-of-type(2)').style.setProperty(
            'height',
            rpane.offsetHeight + 'px'
        );
    }
})();

// The padlock/eraser must be manually positioned:
// - Its vertical position depends on the height of the popup title bar
// - Its horizontal position depends on whether there is a vertical scrollbar.
document.getElementById('rulesetTools').style.setProperty(
    'top',
    (document.getElementById('gotoPrefs').getBoundingClientRect().bottom + 3) + 'px'
);

var positionRulesetTools = function() {
    document.getElementById('rulesetTools').style.setProperty(
        'left',
        (document.getElementById('firewallContainer').getBoundingClientRect().left + 3) + 'px'
    );
};

// https://github.com/chrisaljoudi/uBlock/issues/996
// Experimental: mitigate glitchy popup UI: immediately set the firewall pane
// visibility to its last known state. By default the pane is hidden.
// Will remove if it makes no difference.
if ( dfPaneVisibleStored ) {
    document.getElementById('panes').classList.add('dfEnabled');
}

/******************************************************************************/

var popupData = {};
var dfPaneBuilt = false;
var reIP = /^\d+(?:\.\d+){1,3}$/;
var reSrcHostnameFromRule = /^d[abn]:([^ ]+) ([^ ]+) ([^ ]+)/;
var scopeToSrcHostnameMap = {
    '/': '*',
    '.': ''
};
var threePlus = '+++';
var threeMinus = '−−−';
var sixSpace = '\u2007\u2007\u2007\u2007\u2007\u2007';
var dfHotspots = null;
var hostnameToSortableTokenMap = {};
var allDomains = {};
var allDomainCount = 0;
var allHostnameRows = [];
var touchedDomainCount = 0;
var rowsToRecycle = uDom();
var cachedPopupHash = '';
var statsStr = vAPI.i18n('popupBlockedStats');
var domainsHitStr = vAPI.i18n('popupHitDomainCount');
var reNetworkRelatedURL = /^(?:ftps?|https?|wss?):\/\//;

/******************************************************************************/

// https://github.com/gorhill/httpswitchboard/issues/345

var messager = vAPI.messaging.channel('popup.js');

/******************************************************************************/

var cachePopupData = function(data) {
    popupData = {};
    scopeToSrcHostnameMap['.'] = '';
    hostnameToSortableTokenMap = {};

    if ( typeof data !== 'object' ) {
        return popupData;
    }
    popupData = data;
    scopeToSrcHostnameMap['.'] = popupData.pageHostname || '';
    var hostnameDict = popupData.hostnameDict;
    if ( typeof hostnameDict !== 'object' ) {
        return popupData;
    }
    var domain, prefix;
    for ( var hostname in hostnameDict ) {
        if ( hostnameDict.hasOwnProperty(hostname) === false ) {
            continue;
        }
        domain = hostnameDict[hostname].domain;
        if ( domain === popupData.pageDomain ) {
            domain = '\u0020';
        }
        prefix = hostname.slice(0, 0 - domain.length);
        hostnameToSortableTokenMap[hostname] = domain + prefix.split('.').reverse().join('.');
    }
    return popupData;
};

/******************************************************************************/

var hashFromPopupData = function(reset) {
    // It makes no sense to offer to refresh the behind-the-scene scope
    if ( popupData.pageHostname === 'behind-the-scene' ) {
        uDom('body').toggleClass('dirty', false);
        return;
    }

    var hasher = [];
    var rules = popupData.firewallRules;
    var rule;
    for ( var key in rules ) {
        if ( rules.hasOwnProperty(key) === false ) {
            continue;
        }
        rule = rules[key];
        if ( rule !== '' ) {
            hasher.push(rule);
        }
    }
    hasher.sort();
    hasher.push(uDom('body').hasClass('off'));
    hasher.push(uDom.nodeFromId('no-cosmetic-filtering').classList.contains('on'));
    hasher.push(uDom.nodeFromId('no-remote-fonts').classList.contains('on'));

    var hash = hasher.join('');
    if ( reset ) {
        cachedPopupHash = hash;
    }
    uDom('body').toggleClass('dirty', hash !== cachedPopupHash);
};

/******************************************************************************/

var formatNumber = function(count) {
    return typeof count === 'number' ? count.toLocaleString() : '';
};

/******************************************************************************/

var rulekeyCompare = function(a, b) {
    var ha = a.slice(2, a.indexOf(' ', 2));
    if ( !reIP.test(ha) ) {
        ha = hostnameToSortableTokenMap[ha] || '';
    }
    var hb = b.slice(2, b.indexOf(' ', 2));
    if ( !reIP.test(hb) ) {
        hb = hostnameToSortableTokenMap[hb] || '';
    }
    return ha.localeCompare(hb);
};

/******************************************************************************/

var addFirewallRow = function(des) {
    var row = rowsToRecycle.pop();
    if ( row.length === 0 ) {
        row = uDom('#templates > div:nth-of-type(1)').clone();
    }

    row.descendants('[data-des]').attr('data-des', des);
    row.descendants('span:nth-of-type(1)').text(punycode.toUnicode(des));

    var hnDetails = popupData.hostnameDict[des] || {};
    var isDomain = des === hnDetails.domain;
    row.toggleClass('isDomain', isDomain)
       .toggleClass('isSubDomain', !isDomain)
       .toggleClass('allowed', hnDetails.allowCount !== 0)
       .toggleClass('blocked', hnDetails.blockCount !== 0)
       .toggleClass('totalAllowed', hnDetails.totalAllowCount !== 0)
       .toggleClass('totalBlocked', hnDetails.totalBlockCount !== 0);

    row.appendTo('#firewallContainer');

    return row;
};

/******************************************************************************/

var updateFirewallCell = function(scope, des, type, rule) {
    return;
};

/******************************************************************************/

var updateAllFirewallCells = function() {
    return;
};

/******************************************************************************/

var buildAllFirewallRows = function() {
    // Do this before removing the rows
    /*
    if ( dfHotspots === null ) {
        dfHotspots = uDom('#actionSelector')
            .toggleClass('colorBlind', popupData.colorBlindFriendly)
            .on('click', 'span', setFirewallRuleHandler);
    }
    dfHotspots.detach();
    */

    // Remove and reuse all rows: the order may have changed, we can't just
    // reuse them in-place.
    rowsToRecycle = uDom('#firewallContainer > div:nth-of-type(7) ~ div').detach();

    var n = allHostnameRows.length;
    for ( var i = 0; i < n; i++ ) {
        addFirewallRow(allHostnameRows[i]);
    }

    if ( dfPaneBuilt !== true ) {
        /*uDom('#firewallContainer')
            .on('click', 'span[data-src]', unsetFirewallRuleHandler)
            .on('mouseenter', '[data-src]', mouseenterCellHandler)
            .on('mouseleave', '[data-src]', mouseleaveCellHandler);
            */
        dfPaneBuilt = true;
    }
};

/******************************************************************************/

var renderPrivacyExposure = function() {
    allDomains = {};
    allDomainCount = touchedDomainCount = 0;
    allHostnameRows = [];

    // Sort hostnames. First-party hostnames must always appear at the top
    // of the list.
    var desHostnameDone = {};
    var keys = Object.keys(popupData.firewallRules)
                     .sort(rulekeyCompare);
    var key, des, hnDetails;
    for ( var i = 0; i < keys.length; i++ ) {
        key = keys[i];
        des = key.slice(2, key.indexOf(' ', 2));
        // Specific-type rules -- these are built-in
        if ( des === '*' || desHostnameDone.hasOwnProperty(des) ) {
            continue;
        }
        hnDetails = popupData.hostnameDict[des] || {};
        if ( allDomains.hasOwnProperty(hnDetails.domain) === false ) {
            allDomains[hnDetails.domain] = false;
            allDomainCount += 1;
        }
        if ( hnDetails.allowCount !== 0 ) {
            if ( allDomains[hnDetails.domain] === false ) {
                allDomains[hnDetails.domain] = true;
                touchedDomainCount += 1;
            }
        }
        allHostnameRows.push(des);
        desHostnameDone[des] = true;
    }

    // Domain of the page must always be included (if there is one)
    if (
        allDomains.hasOwnProperty(popupData.pageDomain) === false &&
        reNetworkRelatedURL.test(popupData.rawURL)
    ) {
        allHostnameRows.push(popupData.pageDomain);
        allDomains[popupData.pageDomain] = false;
        allDomainCount += 1;
    }

    var summary = domainsHitStr.replace('{{count}}', touchedDomainCount.toLocaleString())
                               .replace('{{total}}', allDomainCount.toLocaleString());
    uDom.nodeFromId('popupHitDomainCount').textContent = summary;
};

/******************************************************************************/

// Assume everything has to be done incrementally.

var renderPopup = function() {
    if ( popupData.tabTitle ) {
        document.title = popupData.appName + ' - ' + popupData.tabTitle;
    }

    uDom.nodeFromId('appname').textContent = popupData.appName;
    uDom.nodeFromId('version').textContent = popupData.appVersion;
    uDom('body')
        .toggleClass('advancedUser', popupData.advancedUserEnabled)
        .toggleClass(
            'off',
            (popupData.pageURL === '') ||
            (!popupData.netFilteringSwitch) ||
            (popupData.pageHostname === 'behind-the-scene' && !popupData.advancedUserEnabled)
        );

    // If you think the `=== true` is pointless, you are mistaken
    uDom.nodeFromId('gotoPick').classList.toggle('enabled', popupData.canElementPicker === true);

    var text;
    var blocked = popupData.pageBlockedRequestCount;
    var total = popupData.pageAllowedRequestCount + blocked;
    if ( total === 0 ) {
        text = formatNumber(0);
    } else {
        text = statsStr.replace('{{count}}', formatNumber(blocked))
                       .replace('{{percent}}', formatNumber(Math.floor(blocked * 100 / total)));
    }
    uDom.nodeFromId('page-blocked').textContent = text;

    blocked = popupData.globalBlockedRequestCount;
    total = popupData.globalAllowedRequestCount + blocked;
    if ( total === 0 ) {
        text = formatNumber(0);
    } else {
        text = statsStr.replace('{{count}}', formatNumber(blocked))
                       .replace('{{percent}}', formatNumber(Math.floor(blocked * 100 / total)));
    }
    uDom.nodeFromId('total-blocked').textContent = text;

    // https://github.com/gorhill/uBlock/issues/507
    // Convenience: open the logger with current tab automatically selected
    if ( popupData.tabId ) {
        uDom.nodeFromSelector('.statName > a[href^="logger-ui.html"]').setAttribute(
            'href',
            'logger-ui.html#tab_' + popupData.tabId
        );
    }

    // This will collate all domains, touched or not
    renderPrivacyExposure();

    // Extra tools
    uDom.nodeFromId('no-popups').classList.toggle('on', popupData.noPopups === true);
    uDom.nodeFromId('no-strict-blocking').classList.toggle('on', popupData.noStrictBlocking === true);
    uDom.nodeFromId('no-cosmetic-filtering').classList.toggle('on', popupData.noCosmeticFiltering === true);
    uDom.nodeFromId('no-remote-fonts').classList.toggle('on', popupData.noRemoteFonts === true);

    // Report remote font count on badge
    total = popupData.remoteFontCount;
    uDom.nodeFromSelector('#no-remote-fonts > span.badge')
        .textContent = total ? total.toLocaleString() : '';

    // https://github.com/chrisaljoudi/uBlock/issues/470
    // This must be done here, to be sure the popup is resized properly
    var dfPaneVisible = popupData.dfEnabled && popupData.advancedUserEnabled;

    // https://github.com/chrisaljoudi/uBlock/issues/1068
    // Remember the last state of the firewall pane. This allows to
    // configure the popup size early next time it is opened, which means a
    // less glitchy popup at open time.
    if ( dfPaneVisible !== dfPaneVisibleStored ) {
        dfPaneVisibleStored = dfPaneVisible;
        vAPI.localStorage.setItem('popupFirewallPane', dfPaneVisibleStored);
    }

    uDom.nodeFromId('panes').classList.toggle('dfEnabled', dfPaneVisible);
    uDom('#firewallContainer')
        .toggleClass('minimized', popupData.firewallPaneMinimized)
        .toggleClass('colorBlind', popupData.colorBlindFriendly);

    // Build dynamic filtering pane only if in use
    if ( dfPaneVisible ) {
        buildAllFirewallRows();
    }
};

/******************************************************************************/

var renderPopupLazy = function() {
    var onDataReady = function(data) {
        if ( !data ) { return; }
        var v = data.hiddenElementCount || '';
        uDom.nodeFromSelector('#no-cosmetic-filtering > span.badge')
            .textContent = typeof v === 'number' ? v.toLocaleString() : v;
    };

    messager.send({
        what: 'getPopupDataLazy',
        tabId: popupData.tabId
    }, onDataReady);
};

/******************************************************************************/

var toggleNetFilteringSwitch = function(ev) {
    if ( !popupData || !popupData.pageURL ) {
        return;
    }
    if ( popupData.pageHostname === 'behind-the-scene' && !popupData.advancedUserEnabled ) {
        return;
    }
    messager.send({
        what: 'toggleNetFiltering',
        url: popupData.pageURL,
        scope: ev.ctrlKey || ev.metaKey ? 'page' : '',
        state: !uDom('body').toggleClass('off').hasClass('off'),
        tabId: popupData.tabId
    });

    hashFromPopupData();
};

/******************************************************************************/

var gotoPick = function() {
    messager.send({
        what: 'launchElementPicker',
        tabId: popupData.tabId
    });

    vAPI.closePopup();
};

/******************************************************************************/

var gotoURL = function(ev) {
    if ( this.hasAttribute('href') === false) {
        return;
    }

    ev.preventDefault();

    var rel = this.getAttribute('rel') || '';

    messager.send({
        what: 'gotoURL',
        details: {
            url: this.getAttribute('href'),
            select: true,
            index: -1,
            popup: rel === 'popup' && ev.shiftKey
        }
    });

    vAPI.closePopup();
};

/******************************************************************************/

var toggleFirewallPane = function() {
    if ( popupData.advancedUserEnabled === false ) {
        return;
    }
    popupData.dfEnabled = !popupData.dfEnabled;

    messager.send({
        what: 'userSettings',
        name: 'dynamicFilteringEnabled',
        value: popupData.dfEnabled
    });

    // https://github.com/chrisaljoudi/uBlock/issues/996
    // Remember the last state of the firewall pane. This allows to
    // configure the popup size early next time it is opened, which means a
    // less glitchy popup at open time.
    dfPaneVisibleStored = popupData.dfEnabled;
    vAPI.localStorage.setItem('popupFirewallPane', dfPaneVisibleStored);

    // Dynamic filtering pane may not have been built yet
    uDom.nodeFromId('panes').classList.toggle('dfEnabled', popupData.dfEnabled);
    if ( popupData.dfEnabled && dfPaneBuilt === false ) {
        buildAllFirewallRows();
    }
};

/******************************************************************************/

var mouseenterCellHandler = function() {
  return;
    if ( uDom(this).hasClass('ownRule') === false ) {
        dfHotspots.appendTo(this);
    }
};

var mouseleaveCellHandler = function() {
  return;
    dfHotspots.detach();
};

/******************************************************************************/

var setFirewallRule = function(src, des, type, action, persist) {
    // This can happen on pages where uBlock does not work
    return;
    if ( typeof popupData.pageHostname !== 'string' || popupData.pageHostname === '' ) {
        return;
    }
    var onFirewallRuleChanged = function(response) {
        cachePopupData(response);
        updateAllFirewallCells();
        hashFromPopupData();
    };
    messager.send({
        what: 'toggleFirewallRule',
        tabId: popupData.tabId,
        pageHostname: popupData.pageHostname,
        srcHostname: src,
        desHostname: des,
        requestType: type,
        action: action,
        persist: persist
    }, onFirewallRuleChanged);
};

/******************************************************************************/

var unsetFirewallRuleHandler = function(ev) {
  return;
    var cell = uDom(this);
    setFirewallRule(
        cell.attr('data-src') === '/' ? '*' : popupData.pageHostname,
        cell.attr('data-des'),
        cell.attr('data-type'),
        0,
        ev.ctrlKey || ev.metaKey
    );
    dfHotspots.appendTo(cell);
};

/******************************************************************************/

var setFirewallRuleHandler = function(ev) {
  return;
    var hotspot = uDom(this);
    var cell = hotspot.ancestors('[data-src]');
    if ( cell.length === 0 ) {
        return;
    }
    var action = 0;
    var hotspotId = hotspot.attr('id');
    if ( hotspotId === 'dynaAllow' ) {
        action = 2;
    } else if ( hotspotId === 'dynaNoop' ) {
        action = 3;
    } else {
        action = 1;
    }
    setFirewallRule(
        cell.attr('data-src') === '/' ? '*' : popupData.pageHostname,
        cell.attr('data-des'),
        cell.attr('data-type'),
        action,
        ev.ctrlKey || ev.metaKey
    );
    dfHotspots.detach();
};

/******************************************************************************/

var reloadTab = function() {
    messager.send({ what: 'reloadTab', tabId: popupData.tabId, select: true });

    // Polling will take care of refreshing the popup content

    // https://github.com/chrisaljoudi/uBlock/issues/748
    // User forces a reload, assume the popup has to be updated regardless if
    // there were changes or not.
    popupData.contentLastModified = -1;

    // No need to wait to remove this.
    uDom('body').toggleClass('dirty', false);
};

/******************************************************************************/

var toggleMinimize = function() {
    popupData.firewallPaneMinimized = uDom.nodeFromId('firewallContainer')
                                          .classList
                                          .toggle('minimized');
    messager.send({
        what: 'userSettings',
        name: 'firewallPaneMinimized',
        value: popupData.firewallPaneMinimized
    });
    positionRulesetTools();
};

/******************************************************************************/

var saveFirewallRules = function() {
  return;
    messager.send({
        what: 'saveFirewallRules',
        srcHostname: popupData.pageHostname,
        desHostnames: popupData.hostnameDict
    });
    uDom.nodeFromId('firewallContainer').classList.remove('dirty');
};

/******************************************************************************/

var revertFirewallRules = function() {
  return;
    var onFirewallRuleChanged = function(response) {
        cachePopupData(response);
        updateAllFirewallCells();
        hashFromPopupData();
    };
    messager.send({
        what: 'revertFirewallRules',
        srcHostname: popupData.pageHostname,
        desHostnames: popupData.hostnameDict,
        tabId: popupData.tabId
    }, onFirewallRuleChanged);
    uDom.nodeFromId('firewallContainer').classList.remove('dirty');
};

/******************************************************************************/

var toggleHostnameSwitch = function() {
    var elem = uDom(this);
    var switchName = elem.attr('id');
    if ( !switchName ) {
        return;
    }
    elem.toggleClass('on');
    messager.send({
        what: 'toggleHostnameSwitch',
        name: switchName,
        hostname: popupData.pageHostname,
        state: elem.hasClass('on'),
        tabId: popupData.tabId
    });
    hashFromPopupData();
};

/******************************************************************************/

// Poll for changes.
//
// I couldn't find a better way to be notified of changes which can affect
// popup content, as the messaging API doesn't support firing events accurately
// from the main extension process to a specific auxiliary extension process:
//
// - broadcasting() is not an option given there could be a lot of tabs opened,
//   and maybe even many frames within these tabs, i.e. unacceptable overhead
//   regardless of whether the popup is opened or not.
//
// - Modifying the messaging API is not an option, as this would require
//   revisiting all platform-specific code to support targeted broadcasting,
//   which who knows could be not so trivial for some platforms.
//
// A well done polling is a better anyways IMO, I prefer that data is pulled
// on demand rather than forcing the main process to assume a client may need
// it and thus having to push it all the time unconditionally.

var pollForContentChange = (function() {
    var pollTimer = null;

    var pollCallback = function() {
        pollTimer = null;
        messager.send(
            {
                what: 'hasPopupContentChanged',
                tabId: popupData.tabId,
                contentLastModified: popupData.contentLastModified
            },
            queryCallback
        );
    };

    var queryCallback = function(response) {
        if ( response ) {
            getPopupData(popupData.tabId);
            return;
        }
        poll();
    };

    var poll = function() {
        if ( pollTimer !== null ) {
            return;
        }
        pollTimer = vAPI.setTimeout(pollCallback, 1500);
    };

    return poll;
})();

/******************************************************************************/

var getPopupData = function(tabId) {
    var onDataReceived = function(response) {
        cachePopupData(response);
        renderPopup();
        renderPopupLazy(); // low priority rendering
        hashFromPopupData(true);

        uDom('#panes #rate button').on('click', updateVote);

        pollForContentChange();
    };
    messager.send({ what: 'getPopupData', tabId: tabId }, onDataReceived);
};

/******************************************************************************/

var onShowTooltip = function() {
    if ( popupData.advancedUserEnabled ) {
        return;
    }

    var tip = document.getElementById('tooltip');
    var target = this;

    tip.textContent = target.getAttribute('data-tip');
    tip.style.removeProperty('top');
    tip.style.removeProperty('bottom');

    // Default is "over"
    var pos;
    var over = target.getAttribute('data-tip-position') !== 'under';
    if ( over ) {
        pos = document.body.getBoundingClientRect().height -
              target.getBoundingClientRect().top;
        tip.style.setProperty('bottom', pos + 'px');
    } else {
        pos = target.getBoundingClientRect().bottom;
        tip.style.setProperty('top', pos + 'px');
    }

    uDom(tip).addClass('show');
};

var onHideTooltip = function() {
    uDom.nodeFromId('tooltip').classList.remove('show');
};

var updateVote = function() {
    var url = 'http://calhacksmachine.cloudapp.net:5000/api/v1.0/rate';
    var xhr = new XMLHttpRequest();
    var vote = this.dataset.vote === '+' ? 1 : -1;
    var body = {
        'url': this.parentElement.dataset.des,
        'rating': vote
    };

    xhr.open('post', url, true);
    xhr.timeout = 10000;
    xhr.method = 'POST';
    xhr.responseType = 'json';
    xhr.onload = function() {};
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(body));
};

/******************************************************************************/

var changeGlobalSlider = function(event) {
    console.log(event.target.value);
    document.getElementById('sliderValue').innerHTML = event.target.value;
    var url = 'http://calhacksmachine.cloudapp.net:5000/api/v1.0/generateByPercentile';
    var body = {
        rating: event.currentTarget.value
    };
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.timeout = 10000;
    xhr.responseType = 'json';
    xhr.onload = function() {
        var response = _getResponse(this);
        var filterUrl = response.list;
        messager.send({
            what: 'userSettings',
            name: 'externalLists',
            value: filterUrl
        });
        uDom('body').toggleClass('dirty', true);
    };
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(body));
};

var _getResponse = function(xhr) {
    var data;
    if (!xhr.responseType || xhr.responseType === "text") {
        data = xhr.responseText;
    } else if (xhr.responseType === "document") {
        data = xhr.responseXML;
    } else {
        data = xhr.response;
    }
    return data;

};

/*********************************************/
// Popup DOM is assumed to be loaded at this point -- because this script
// is loaded after everything else..

(function() {
    // If there's no tab id specified in the query string,
    // it will default to current tab.
    var tabId = null;

    // Extract the tab id of the page this popup is for
    var matches = window.location.search.match(/[\?&]tabId=([^&]+)/);
    if ( matches && matches.length === 2 ) {
        tabId = matches[1];
    }
    getPopupData(tabId);

    uDom('#switch').on('click', toggleNetFilteringSwitch);
    uDom('#gotoPick').on('click', gotoPick);
    uDom('a[href]').on('click', gotoURL);
    uDom('h2').on('click', toggleFirewallPane);
    uDom('#refresh').on('click', reloadTab);
    uDom('.hnSwitch').on('click', toggleHostnameSwitch);
    uDom('#saveRules').on('click', saveFirewallRules);
    uDom('#revertRules').on('click', revertFirewallRules);
    uDom('[data-i18n="popupAnyRulePrompt"]').on('click', toggleMinimize);
    document.getElementById('sliderInput').addEventListener('change', changeGlobalSlider);
    document.getElementById('sliderInput').defaultValue = 50;
    document.getElementById('sliderValue').innerHTML = 50;
    uDom('body').on('mouseenter', '[data-tip]', onShowTooltip)
                .on('mouseleave', '[data-tip]', onHideTooltip);
})();

/******************************************************************************/

})();
