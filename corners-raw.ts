// test-corners.ts
import { fetchCornersData } from './src/scrapers/football/soccerStatsCornersScraper';

async function main() {
  for (const league of ['Austria', 'Scotland - Premiership', 'Turkey']) {
    const data = await fetchCornersData(league);
    console.log(league, '→', data ? `${data.teams.size} teams` : 'NULL');
  }
}

main().catch(console.error);
































<!DOCTYPE html>
<html lang="en">
<head>

<script>window['gtag_enable_tcf_support'] = true;</script>

 

<!-- InMobi Choice. Consent Manager Tag v3.0 (for TCF 2.2) -->
<script type="text/javascript" async=true>
(function() {
var host = 'www.soccerstats.com';
var element = document.createElement('script');
var firstScript = document.getElementsByTagName('script')[0];
var url = 'https://cmp.inmobi.com'
.concat('/choice/', '713JMgae9AkWE', '/', host, '/choice.js?tag_version=V3');
var uspTries = 0;
var uspTriesLimit = 3;
element.async = true;
element.type = 'text/javascript';
element.src = url;

firstScript.parentNode.insertBefore(element, firstScript);

function makeStub() {
var TCF_LOCATOR_NAME = '__tcfapiLocator';
var queue = [];
var win = window;
var cmpFrame;

function addFrame() {
var doc = win.document;
var otherCMP = !!(win.frames[TCF_LOCATOR_NAME]);

if (!otherCMP) {
if (doc.body) {
var iframe = doc.createElement('iframe');

iframe.style.cssText = 'display:none';
iframe.name = TCF_LOCATOR_NAME;
doc.body.appendChild(iframe);
} else {
setTimeout(addFrame, 5);
}
}
return !otherCMP;
}

function tcfAPIHandler() {
var gdprApplies;
var args = arguments;

if (!args.length) {
return queue;
} else if (args[0] === 'setGdprApplies') {
if (
args.length > 3 &&
args[2] === 2 &&
typeof args[3] === 'boolean'
) {
gdprApplies = args[3];
if (typeof args[2] === 'function') {
args[2]('set', true);
}
}
} else if (args[0] === 'ping') {
var retr = {
gdprApplies: gdprApplies,
cmpLoaded: false,
cmpStatus: 'stub'
};

if (typeof args[2] === 'function') {
args[2](retr);
}
} else {
if(args[0] === 'init' && typeof args[3] === 'object') {
args[3] = Object.assign(args[3], { tag_version: 'V3' });
}
queue.push(args);
}
}

function postMessageEventHandler(event) {
var msgIsString = typeof event.data === 'string';
var json = {};

try {
if (msgIsString) {
json = JSON.parse(event.data);
} else {
json = event.data;
}
} catch (ignore) {}

var payload = json.__tcfapiCall;

if (payload) {
window.__tcfapi(
payload.command,
payload.version,
function(retValue, success) {
var returnMsg = {
  __tcfapiReturn: {
    returnValue: retValue,
    success: success,
    callId: payload.callId
  }
};
if (msgIsString) {
  returnMsg = JSON.stringify(returnMsg);
}
if (event && event.source && event.source.postMessage) {
  event.source.postMessage(returnMsg, '*');
}
},
payload.parameter
);
}
}

while (win) {
try {
if (win.frames[TCF_LOCATOR_NAME]) {
cmpFrame = win;
break;
}
} catch (ignore) {}

if (win === window.top) {
break;
}
win = win.parent;
}
if (!cmpFrame) {
addFrame();
win.__tcfapi = tcfAPIHandler;
win.addEventListener('message', postMessageEventHandler, false);
}
};

makeStub();

function makeGppStub() {
const CMP_ID = 10;
const SUPPORTED_APIS = [
'2:tcfeuv2',
'6:uspv1',
'7:usnatv1',
'8:usca',
'9:usvav1',
'10:uscov1',
'11:usutv1',
'12:usctv1'
];

window.__gpp_addFrame = function (n) {
if (!window.frames[n]) {
if (document.body) {
var i = document.createElement("iframe");
i.style.cssText = "display:none";
i.name = n;
document.body.appendChild(i);
} else {
window.setTimeout(window.__gpp_addFrame, 10, n);
}
}
};
window.__gpp_stub = function () {
var b = arguments;
__gpp.queue = __gpp.queue || [];
__gpp.events = __gpp.events || [];

if (!b.length || (b.length == 1 && b[0] == "queue")) {
return __gpp.queue;
}

if (b.length == 1 && b[0] == "events") {
return __gpp.events;
}

var cmd = b[0];
var clb = b.length > 1 ? b[1] : null;
var par = b.length > 2 ? b[2] : null;
if (cmd === "ping") {
clb(
{
gppVersion: "1.1", // must be “Version.Subversion”, current: “1.1”
cmpStatus: "stub", // possible values: stub, loading, loaded, error
cmpDisplayStatus: "hidden", // possible values: hidden, visible, disabled
signalStatus: "not ready", // possible values: not ready, ready
supportedAPIs: SUPPORTED_APIS, // list of supported APIs
cmpId: CMP_ID, // IAB assigned CMP ID, may be 0 during stub/loading
sectionList: [],
applicableSections: [-1],
gppString: "",
parsedSections: {},
},
true
);
} else if (cmd === "addEventListener") {
if (!("lastId" in __gpp)) {
__gpp.lastId = 0;
}
__gpp.lastId++;
var lnr = __gpp.lastId;
__gpp.events.push({
id: lnr,
callback: clb,
parameter: par,
});
clb(
{
eventName: "listenerRegistered",
listenerId: lnr, // Registered ID of the listener
data: true, // positive signal
pingData: {
  gppVersion: "1.1", // must be “Version.Subversion”, current: “1.1”
  cmpStatus: "stub", // possible values: stub, loading, loaded, error
  cmpDisplayStatus: "hidden", // possible values: hidden, visible, disabled
  signalStatus: "not ready", // possible values: not ready, ready
  supportedAPIs: SUPPORTED_APIS, // list of supported APIs
  cmpId: CMP_ID, // list of supported APIs
  sectionList: [],
  applicableSections: [-1],
  gppString: "",
  parsedSections: {},
},
},
true
);
} else if (cmd === "removeEventListener") {
var success = false;
for (var i = 0; i < __gpp.events.length; i++) {
if (__gpp.events[i].id == par) {
__gpp.events.splice(i, 1);
success = true;
break;
}
}
clb(
{
eventName: "listenerRemoved",
listenerId: par, // Registered ID of the listener
data: success, // status info
pingData: {
  gppVersion: "1.1", // must be “Version.Subversion”, current: “1.1”
  cmpStatus: "stub", // possible values: stub, loading, loaded, error
  cmpDisplayStatus: "hidden", // possible values: hidden, visible, disabled
  signalStatus: "not ready", // possible values: not ready, ready
  supportedAPIs: SUPPORTED_APIS, // list of supported APIs
  cmpId: CMP_ID, // CMP ID
  sectionList: [],
  applicableSections: [-1],
  gppString: "",
  parsedSections: {},
},
},
true
);
} else if (cmd === "hasSection") {
clb(false, true);
} else if (cmd === "getSection" || cmd === "getField") {
clb(null, true);
}
//queue all other commands
else {
__gpp.queue.push([].slice.apply(b));
}
};
window.__gpp_msghandler = function (event) {
var msgIsString = typeof event.data === "string";
try {
var json = msgIsString ? JSON.parse(event.data) : event.data;
} catch (e) {
var json = null;
}
if (typeof json === "object" && json !== null && "__gppCall" in json) {
var i = json.__gppCall;
window.__gpp(
i.command,
function (retValue, success) {
var returnMsg = {
  __gppReturn: {
    returnValue: retValue,
    success: success,
    callId: i.callId,
  },
};
event.source.postMessage(msgIsString ? JSON.stringify(returnMsg) : returnMsg, "*");
},
"parameter" in i ? i.parameter : null,
"version" in i ? i.version : "1.1"
);
}
};
if (!("__gpp" in window) || typeof window.__gpp !== "function") {
window.__gpp = window.__gpp_stub;
window.addEventListener("message", window.__gpp_msghandler, false);
window.__gpp_addFrame("__gppLocator");
}
};

makeGppStub();

var uspStubFunction = function() {
var arg = arguments;
if (typeof window.__uspapi !== uspStubFunction) {
setTimeout(function() {
if (typeof window.__uspapi !== 'undefined') {
window.__uspapi.apply(window.__uspapi, arg);
}
}, 500);
}
};

var checkIfUspIsReady = function() {
uspTries++;
if (window.__uspapi === uspStubFunction && uspTries < uspTriesLimit) {
console.warn('USP is not accessible');
} else {
clearInterval(uspInterval);
}
};

if (typeof window.__uspapi === 'undefined') {
window.__uspapi = uspStubFunction;
var uspInterval = setInterval(checkIfUspIsReady, 6000);
}
})();
</script>
<!-- End InMobi Choice. Consent Manager Tag v3.0 (for TCF 2.2) -->

<!-- call adsense script after CMP call -->
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3910539363731532" crossorigin="anonymous"></script>

<script async src="https://tags.refinery89.com/v2/soccerstatscom.js"></script>



<!-- GAM header tag -->

<script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js" crossorigin="anonymous"></script>
<script>
  window.googletag = window.googletag || {cmd: []};
  googletag.cmd.push(function() {
	
    googletag.defineSlot('/22517009859/Top_Billboard_970x250', [[970, 250], [970, 90], [728, 90]], 'div-gpt-ad-1769709546484-0').addService(googletag.pubads());
 	googletag.defineSlot('/22517009859/Sidebar_Multi_Size', [[300, 600], [300, 250]], 'div-gpt-ad-1769795655430-0').addService(googletag.pubads());	
  	googletag.defineSlot('/22517009859/Sidebar_160x600', [160, 600], 'div-gpt-ad-1770399694988-0').addService(googletag.pubads());	
	  
    googletag.pubads().enableSingleRequest();
    googletag.pubads().collapseEmptyDivs();
    googletag.enableServices();
  });
</script>





















<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1" />
<meta http-equiv="Content-Language" content="en" />
<link rel="dns-prefetch" href="//www.googletagmanager.com">
<link rel="dns-prefetch" href="//www.google-analytics.com">
<link rel="dns-prefetch" href="//ajax.googleapis.com">
<meta name="theme-color" content="#ffffff" />



<style>
html,body {
background:#ffffff;
z-index:0;
/*text-align:center;*/
font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
font-size:13px;
line-height:1.3em;
margin:0;
padding:0;
}
#insidetopdiv {
    z-index: 999;
}






@media screen and (max-width: 1484px) {
    .adcol1 {
        min-width: 160px;
    }	
    .headerlocal {
        left: 320px;
    }


    .sidebar3 {
		float: left;
    }	



}







@media screen and (min-width: 1485px) {
    .adcol1 {
        min-width: 160px;
    }	
    .headerlocal {
        left: 320px;
    }


    .sidebar3 {
		float: left;
    }	
}




#container_old {
width:100%!important;
    top: 0;

text-align:left;
margin:0 auto;
padding:0 0;
}
#content_old {
margin:0;
padding:0;
}

#content {
    background-color:#ffffff;        
    overflow-x: hidden;
    clear: both;
    border: 0px solid;
	width: 990px;
    display: block;
    text-align:center;	
	float: left;
}
.rightcol {
	background:#f0f0f0;
}


.centerimg {
  display: block;
  margin-left: auto;
  margin-right: auto;
}


/* Top scroll */

.fixed-header {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%; 
}
  
/* End of Top scroll */

























.sidebar1 {
height: 100%;
width: 140px;
position: absolute;
top: 0px;
left: 0px;
padding-top: 0px;
background-color: #f8f8f8;
border-color: #f8f8f8;
}

.sidebar1 div {
margin-left: 4px;
padding-right: 0px;
display: block;
border-color: #f8f8f8;
}


#topdiv {
	position: fixed;
	top: 0px;	
	height: 50px;
	width: 100%;
    z-index: 999;
}




#headerlocal {
	padding-top:1px;
	top: 50px;	
	height:120px;	
    z-index: 999;
	width: 990px;
}



.sidebar2 {
height:1800px;
width: 320px;
margin-left: 996px;
text-align: left;
position: fixed;
top: 0;
left: 0;
padding-top: 0px;
background-color: #f0f0f0;
border-color: #f8f8f8;
}

.sidebar2 div {
padding-left: 8px;
padding-right: 8px;
display: block;
border-color: #f8f8f8;
}



.sidebar3 {
height: 1800px;
width: 390px;
padding-left: 4px;
top: 0;
left: 0;

		padding-top: 300px;
	

float: left;
}

.sidebar3 div {
padding-left: 1px;
padding-right: 1px;
}



.sidebar4 {
height: 1800px;
width: 320px;
margin-left: 996px;
top: 0;
left: 0;
padding-top: 600px;
background-color: #ffffff;
border-color: #ffffff;
float: left;
}

.sidebar4 div {
padding-left: 8px;
padding-right: 8px;
border-color: #ffffff;
}











.body-text {
margin-left: 6px;
width: 990px;
height: 100%;
background-color: #ffffff;
font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
font-size:13px;
color:#000000;
border-color:#f8f8f8;
}





/* Grid
 */
.container {
  position: relative;
  width: 100%;
  max-width: 990px;
  margin: 0 auto;
  padding: 0 1px;
  box-sizing: border-box; }
.column,
.columns {
  width: 100%;
  float: left;
  box-sizing: border-box; }

/* For devices larger than 400px */
@media (min-width: 400px) {
  .container {
    width: 99%;
    padding: 0; }
}

/* For devices larger than 550px */
@media (min-width: 550px) {
  .container {
    width: 98%; }
  .column,
  .columns {
    margin-left: 0%; }
  .column:first-child,
  .columns:first-child {
    margin-left: 0; }

  .one.column,
  .one.columns                    { width: 4.66666666667%; }
  .two.columns                    { width: 16%; }
  .three.columns                  { width: 18%;            }
  .four.columns                   { width: 31%; }
  .five.columns                   { width: 40.3333333333%; }
  .six.columns                    { width: 48%;            }
  .seven.columns                  { width: 55.5666666%; }
  .eight.columns                  { width: 66%; }
  .nine.columns                   { width: 78.0%;          }
  .ten.columns                    { width: 82.6666666667%; }
  .eleven.columns                 { width: 91.3333333333%; }
  .twelve.columns                 { width: 100%; margin-left: 0; }

  .one-third.column               { width: 30.6666666667%; }
  .two-thirds.column              { width: 65.3333333333%; }

  .one-half.column                { width: 48%; }
  
  
  
}














h1 {
font-family: Arial, Verdana, sans-serif;
font-size:17px;
line-height:20px;
font-weight:700;
color:#444444;
margin-top:0px;
margin-bottom:0px;
padding: 0; 
}

h2 {
font-family: Arial, Verdana, sans-serif;
font-size:16px;
font-weight:600;
color:#444444;
margin-left:2px;
margin-top:4px;
margin-bottom:2px;
padding: 0; 
}

h3 {
font-family: Arial, Verdana, sans-serif;
font-size:14px;
font-weight:610;
color:#444444;
margin-top:2px;
margin-bottom:0px;
padding: 0; 
}

h4 {
font-family: Arial, Verdana, sans-serif;
font-size:13.5px;
font-weight:600;
color:#444444;
margin-top:3px;
margin-bottom:3px;
padding: 0; 
}

li {
	list-style-type: disc;
	margin-top: 2px;
	margin-left: 20px;
}


form.leaguelist {
font-size:11px;
border:0 none;
margin:0;
padding:0;
}

select.leaguelist {
border:1px;
font-size:13px;
border-color: #CCCCCC;
color:#000;
background:#F0F0F0;
list-style:none;
border-style:solid;
margin:0;
padding:2px;
}


optgroup { font-size:11px; }

option.leaguelist {
font-size:11px;
color:blue;
}

select.statslist {
max-height:120px;
border:1px;
border-color: #CCCCCC;
font-size:13px;
color:#000;
background:#F0F0F0;
list-style:none;
border-style:solid;
margin:0;
padding:0;
}



#btable,#htable {
width:100%;
text-align:left;
border-collapse:collapse;
margin:0;
}

#btable tr:hover td,#htable .even {
background:#f0f0f0;
}

#btable tr:hover .nohover {
background:#ffffff;
}


#btable .odd,#htable .odd, #btable .even {
background:#ffffff;
}


#btable th {
font-weight:400;
background:#f0f0f0;
border-bottom:1px solid #dddddd;
padding:2px;
}

#btable td {
border-bottom:1px solid #dddddd;
border-top:1px solid transparent;
padding:1px;
}

#btable .even {
background:#f8f8f8;
}


.bargray {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #c0c0c0;
    vertical-align: baseline;
}


.bargreen {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #339933;
    vertical-align: baseline;
}

.barorange {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #FF9933;
    vertical-align: baseline;
}

.barcyan {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #dddddd;
    vertical-align: baseline;
}


.barpurple {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #bbbbbb;
    vertical-align: baseline;
}



.barred {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #FF0000;
    vertical-align: baseline;
}

.barblue {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #6699ff;
    vertical-align: baseline;
}


.barouthome {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #6082B6;
    vertical-align: baseline;
}

.baroutdraw {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #A9A9A9;
    vertical-align: baseline;
}

.baroutaway {
    float:left;
    height:13px;
    margin: 0px;
    display: inline-block;
    background-color: #7393B3;
    vertical-align: baseline;
}



.dgreen {
    float:left;
    height:13px;
    width:6px;
    margin: 0px 1px 0px 1px;
    display: inline-block;
    vertical-align: baseline;
    background-color: #339933;
}

.dorange {
    float:left;
    height:13px;
    width:6px;
    margin: 0px 1px 0px 1px;
    display: inline-block;
    vertical-align: baseline;
    background-color: #FFB56C;
}

.dred {
    float:left;
    height:13px;
    width:6px;
    margin: 0px 1px 0px 1px;
    display: inline-block;
    vertical-align: baseline;
    background-color: #FF0000;
}

.dgrey {
    float:left;
    height:16px;
    width:15px;
    margin: 0px 1px 0px 1px;
    display: inline-block;
    vertical-align: text-top;
    background-color: #E5E5E5;
}








a.horiz:hover{
text-decoration:none;	
background-color:#eaeaea;
color:#000000;
overflow:hidden;
}


a.horizblog:hover{
text-decoration:none;	
background-color:#eaeaea;
line-height: 40px;
color:#000000;
overflow:hidden;
}







TD.sgreen {
	font-size: 12px;
	color: green;
	text-align: center;
}	

TD.sblack {
	font-size: 12px;
	color: black;
	text-align: center;
}	

TD.sred {
	font-size: 12px;
	color: red;
	text-align: center;
}	

TD.sblue {
	font-size: 12px;
	color: blue;
	text-align: center;
}	

TD.sgray {
	font-size: 11px;
	color: #666666;
	text-align: center;
}	

TD.sgraysorted {
	font-size: 12px;
	color: #222222;
	font-weight: bold;
	text-align: center;
}	

TD.steam {
	font-size: 12px;
	color: #111111;
	text-align: right;
}	













/**
 * dropdown
 */
.dropbtn {
    background-color: #ffffff;
    color: black;
    padding: 2px 6px;
    font-size: 13px;
    border: none;
    cursor: pointer;
	z-index:10;
}

.dropdown {
    position: relative;
    display: inline-block;
	z-index:10;
}

.dropdown-content {
    display: none;
    position: absolute;
    text-align: left;
    right: 0;
    background-color: #ffffff;
    min-width: 80px;
    box-shadow: 0px 8px 16px 0px rgba(0,0,0,0.2);
	z-index:10;
}

.dropdown-content a {
    color: black;
    padding: 2px 6px;
    text-decoration: none;
    display: block;
	z-index:10;
}

.dropdown-content a:hover {background-color: #dddddd;text-decoration: none;}

.dropdown:hover .dropdown-content {
    display: block;
    text-decoration: none;	
}

.dropdown:hover .dropbtn {
    background-color: #dddddd;
}


    .autocomplete-suggestions { border: 1px solid #999; background: #FFFFFF; line-height:14px; overflow: auto; }



	.autocomplete-suggestion { padding: 2px 5px; white-space: nowrap; overflow: hidden; line-height:14px;}
	.autocomplete-selected { background: #F0F0F0; }
	.autocomplete-suggestions strong { font-weight: normal; color: #3399FF; }
	.autocomplete-group { padding: 2px 5px; }
	.autocomplete-group strong { display: block; border-bottom: 1px solid #000; }

#input:active {
    border: none;
	border-radius: 0px;
}
#input:focus {
    border: none;
	border-radius: 0px;
}











img {
border:0;
}

a,a:link,a:visited,a:active {
text-decoration:none;
color:#000000;
}


table,th,td {
color:#000000;
font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
font-size:13px;
}

a:hover {
text-decoration:underline;
}

a.countrylist:hover {
color:#000000;
text-decoration:none;
}


a.myInlineLink
{
display: block;
margin: 10px 10px;
}




#header {
    z-index: 999;
    top: 80px;
    height: 80px;
    background-color:#f8f8f8;
    right: 15px;
    left: 15px;
}






#footer_container {
width:800px;
margin:0 auto;
}

#footer {
font-size:11px;
line-height:1em;
position:relative;
text-align:center;
color:#000;
margin:10px auto;
}

#footer a {
font-size:11px;
color:#000;
}


.myButton {
	background-color:#ffffff;
	border-radius:8px;
	border:1px solid #dcdcdc;
	display:inline-block;
	cursor:pointer;
	color:#444444;
	font-family:Arial;
	font-size:14px;
	font-weight:bold;
	padding:6px 8px;
	text-decoration:none;
}
.myButton:hover {
	background-color:#f0f0f0;
	text-decoration:none;
}
.myButton:active {
	position:relative;
	top:1px;
}



.MediumButton {
	background-color:#ffffff;
	border-radius:6px;
	border:1px solid #dcdcdc;
	display:inline-block;
	cursor:pointer;
	color:#666666;
	font-family:Arial;
	font-size:15px;
	font-weight:bold;
	padding:6px 24px;
	text-decoration:none;
}
.MediumButton:hover {
	background-color:#f6f6f6;
	text-decoration:none;
}
.MediumButton:active {
	position:relative;
	top:1px;
}


.SmallButton {
	background-color:#ffffff;
	border-radius:6px;
	border:1px solid #dcdcdc;
	display:inline-block;
	cursor:pointer;
	color:#333333;
	font-family:Arial;
	font-size:13px;
	font-weight:normal;
	padding:5px 6px 5px 6px;
	text-decoration:none;
}
.SmallButton:hover {
	background-color:#f6f6f6;
	text-decoration:none;
}
.SmallButton:active {
	position:relative;
	top:1px;
}



.vsmall {
	background-color:#ffffff;
	border-radius:6px;
	border:1px solid #dcdcdc;
	display:inline-block;
	cursor:pointer;
	color:#444444;
	font-family:Arial;
	font-size:14px;
	font-weight:normal;
	padding:3px 4px;
	text-decoration:none;
}
.vsmall:hover {
	background-color:#f6f6f6;
	text-decoration:none;
}
.vsmall:active {
	position:relative;
	top:1px;
}

.pScorersList {
margin-top:1px;
padding-top:5px;
padding-bottom:5px;
margin-bottom:1px;
padding-left:5px;
padding-right:5px;
line-height:16px;
font-size:13px;
}



/* Buttons
 */
.button,
button,
input[type="submit"],
input[type="reset"],
input[type="button"] {
  display: inline-block;
  margin-top: 0px;
  margin-bottom: 4px;
  margin-left: 1px;
  margin-right: 0px;
  height: 18px;
  padding: 1px 3px;
  color: #444444;
  text-align: center;
  font-size: 12px;
  font-color: #444444;
  font-weight: 500;
  line-height: 18px;
  text-decoration: none;
  white-space: nowrap;
  background-color: #e0e0e0;
  border-radius: 4px;
  border: 1px solid #dcdcdc;
  cursor: pointer;
  box-sizing: border-box; }
.button:hover {
  background-color: #bbbbbb;
  text-decoration: none;
  font-color: #222222;
}	
button:hover,
input[type="submit"]:hover,
input[type="reset"]:hover,
input[type="button"]:hover{
  background-color: #bbbbbb;
  text-decoration: none;
  font-color: #222222;
}	
.button:focus,
button:focus,
input[type="submit"]:focus,
input[type="reset"]:focus,
input[type="button"]:focus {
  color: #C0392B;
  border-color: #888;
  text-decoration: none;  
  outline: 0; }
.button.button-primary,
button.button-primary,
input[type="submit"].button-primary,
input[type="reset"].button-primary,
input[type="button"].button-primary {
  margin-top: 4px;
  color: #333333;
  background-color: #f0f0f0;
  border-color: #f0f0f0; }
.button.button-primary:hover,
button.button-primary:hover,
input[type="submit"].button-primary:hover,
input[type="reset"].button-primary:hover,
input[type="button"].button-primary:hover,
.button.button-primary:focus,
button.button-primary:focus,
input[type="submit"].button-primary:focus,
input[type="reset"].button-primary:focus,
input[type="button"].button-primary:focus {
  color: gray;
  background-color: lightgray;
  text-decoration: none;
  border-color: lightgray; }

button.button-yellow,
input[type="submit"].button-yellow,
input[type="reset"].button-yellow,
input[type="button"].button-yellow {
  margin-top: 2px;
  color: gray;
  background-color: yellow;
  border-color: yellow; }  

button.button-mobile,
input[type="submit"].button-mobile,
input[type="reset"].button-mobile,
input[type="button"].button-mobile {
  margin-top: 0px;
  color: gray;
  background-color: lightgray;
  border-color: #444444; }  


.button2,
button2,
input[type="submit"],
input[type="reset"],
input[type="button"] {
  display: inline-block;
  margin-top: 2px;
  margin-bottom: 2px;
  margin-left: 2px;
  height: 20px;
  padding: 0px 3px;
  color: #444444;
  text-align: center;
  font-size: 10px;
  font-color: #444444;
  font-weight: 400;
  line-height: 20px;
  text-decoration: none;
  white-space: nowrap;
  background-color: #e0e0e0;
  border-radius: 4px;
  border: 0px solid #bbb;
  cursor: pointer;
  box-sizing: border-box; }
.button2:hover {
  background-color: #bbbbbb;
  text-decoration: none;
  font-color: #222222;
}	
button2:hover,
input[type="submit"]:hover,
input[type="reset"]:hover,
input[type="button"]:hover{
  background-color: #bbbbbb;
  text-decoration: none;
  font-color: #222222;
}	
.button2:focus,
button2:focus,
input[type="submit"]:focus,
input[type="reset"]:focus,
input[type="button"]:focus {
  color: #C0392B;
  border-color: #888;
  text-decoration: none;  
  outline: 0; }







TR.trow1 {
background-color:#FFF;
}

TR.trow2 {
background-color:#E0E0E0;
}

TR.trow3 {
background-color:#F0F0F0;
}

TR.trow4 {
background-color:#d2d2d2;
}

TR.trow5 {
background-color:#C7DEFC;
}

TR.trow6 {
background-color:#C8C8C8;
}

TR.trow7 {
background-color:#6EBDFF;
}

TR.trow8 {
background-color:#f0f0f0;
}



a.liveblognormal{
color:#000000;
text-decoration: none
}

a.liveblognormal:hover{
 text-decoration: underline
}


a.liveblognormal_nounderline{
color:#000000;
text-decoration: none
}

a.liveblognormal_nounderline:hover{
color:navy;
 text-decoration: none
}




a.liveblog{
font-size:14px;
font-weight:600;
color:#333333;
text-decoration: none
}

a.liveblog:hover{
 text-decoration: underline
}

a.liveblog_underline{
font-weight:600;
color:#333333;
text-decoration: underline
}


a.liveblogblue{
font-weight:600;
color:#1DA1F2
}

a.liveblogblue:hover{
}




a.tooltip2 {outline:none; }
a.tooltip2 strong {line-height:30px;}
a.tooltip2:hover {text-decoration:none;} 
a.tooltip2 span {
    z-index:10;display:none; padding:12px 18px;
    margin-top:22px; margin-left:-180px;
    width:340px; line-height:16px;
}
a.tooltip2:hover span{
    display:inline; position:absolute; color:#111;
    border:1px solid #aaaaaa; background:#f8f8f8;}
    
/*CSS3 extras*/
a.tooltip2 span
{
    border-radius:4px;
    -moz-border-radius: 4px;
    -webkit-border-radius: 4px;
        
    -moz-box-shadow: 5px 5px 8px #CCC;
    -webkit-box-shadow: 5px 5px 8px #CCC;
    box-shadow: 5px 5px 8px #CCC;
}



a.tooltip4 {outline:none;text-decoration:none;
	background-color:#ffffff;
	border-radius:6px;
	border:1px solid #dcdcdc;
	display:inline-block;
	cursor:pointer;
	color:#333333;
	font-family:Arial;
	font-size:14px;
	font-weight:bold;
	padding:4px 4px;
	text-decoration:none;
 }
a.tooltip4 strong {line-height:16px;}
a.tooltip4:hover {text-decoration:none;} 
a.tooltip4 span {
    z-index:10;display:none; padding:8px 8px;
    margin-top:33px; margin-left:-140px;
    width:260px; line-height:16px;
	font-size:13px;font-weight:normal;text-align:left;background:#f8f8f8;
}
a.tooltip4:hover span{
    display:inline; position:absolute; color:#111;
    border:1px solid #aaaaaa; background:#f8f8f8;}





a.tooltip5 {outline:none;text-decoration:none;
	background-color:#ffffff;
	border-radius:6px;
	border:1px solid #dcdcdc;
	display:inline-block;
	cursor:pointer;
	color:#333333;
	font-family:Arial;
	font-size:12px;
	font-weight:bold;
	padding:4px 6px;
	text-decoration:none;
 }
a.tooltip5 strong {line-height:16px;}
a.tooltip5:hover {text-decoration:none;} 
a.tooltip5 span {
    z-index:10;display:none; padding:5px 5px;
    margin-top:33px; margin-left:-240px;
    width:250px; line-height:14px;
	font-size:12px;font-weight:normal;text-align:left;background:#f8f8f8;
}
a.tooltip5:hover span{
    display:inline; position:absolute; color:#111;
    border:1px solid #aaaaaa; background:#f8f8f8;}




    
/*CSS3 extras*/
a.tooltip4 span
{
    border-radius:4px;
    -moz-border-radius: 4px;
    -webkit-border-radius: 4px;
        
    -moz-box-shadow: 5px 5px 8px #CCC;
    -webkit-box-shadow: 5px 5px 8px #CCC;
    box-shadow: 5px 5px 8px #CCC;
}





.tabs {
  display: flex;
  flex-wrap: wrap;
  width: 99%;
  padding-top:10px;
  padding-bottom:10px;
}
 
.tabs label {
  order: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 0.8rem 0.5rem;
  margin-right: 0.2rem;
  cursor: pointer;
  background-color: #f8f8f8;
  font-size: 13px;
  font-weight: bold;
  color: #222222;
  transition: background ease 0.3s;
  	
  		padding-left:10px;
  		padding-right:10px;
 
}
 
.tabs .tab {
  order: 9;
  flex-grow: 1;
  width: 100%;
  height: 100%;
  display: none;
  background: #f8f8f8;
  padding: 0.4rem;
  /*box-shadow: -10px 10px 0px 0px #bbbbbb;*/
  border: 1px #aaaaaa solid
}
 
.tabs input[type="radio"] {
  display: none;
}
 
.tabs input[type="radio"]:checked + label {
  background: #e0e0e0;
  border-top: 0px #aaaaaa solid;
  border-left: 0px #aaaaaa solid;
  border-right: 0px #aaaaaa solid;
  border-bottom: 0px #aaaaaa solid;
  color: #444444;
  margin-left: 0.01rem;
  padding-bottom: 0.8rem;
  	
  		padding-left:10px;
  		padding-right:10px;
  
}
 
.tabs input[type="radio"]:checked + label + .tab {
  display: block;
}
 
@media (max-width: 99%) {
  .tabs .tab,
  .tabs label {
   order: initial;
  }
 
  .tabs label {
    width: 100%;
  }
}
 








.top-nav {
  display: flex;
  flex-direction: row;
  align-items: center;
  /* W3C, IE 10+/ Edge, Firefox 16+, Chrome 26+, Opera 12+, Safari 7+ */
  color: #000000;
  height: 50px;
  padding-top: 0.2em;
  padding-bottom: 0.2em;
  padding-left: 0.5em;
  padding-right: 1em;
}

.menu {
  display: flex;
  flex-direction: row;
  list-style-type: none;
  margin: 0;
  padding: 0;
}

.menu > li {
  margin: 0 1rem;
  overflow: hidden;
}

.menu-button-container {
  display: none;
  height: 100%;
  width: 30px;
  cursor: pointer;
  flex-direction: column;
  justify-content: center;
  align-items: center;
}

#menu-toggle {
  display: none;
}

.menu-button,
.menu-button::before,
.menu-button::after {
  display: block;
  background-color: #666666;
  color: #fff;
  position: absolute;
  height: 4px;
  width: 30px;
  transition: transform 400ms cubic-bezier(0.23, 1, 0.32, 1);
  border-radius: 2px;
}

.menu-button::before {
  content: '';
  margin-top: -8px;
}

.menu-button::after {
  content: '';
  margin-top: 8px;
}

#menu-toggle:checked + .menu-button-container .menu-button::before {
  margin-top: 0px;
  transform: rotate(405deg);
}

#menu-toggle:checked + .menu-button-container .menu-button {
  background: rgba(255, 255, 255, 0);
}

#menu-toggle:checked + .menu-button-container .menu-button::after {
  margin-top: 0px;
  transform: rotate(-405deg);
}

@media (max-width: 700px) {
  .menu-button-container {
    display: flex;
  }
  .menu {
    position: absolute;
    top: 0;
    margin-top: 50px;
    left: 0;
    flex-direction: column;
    width: 100%;
    justify-content: center;
    align-items: center;
    z-index: 12;
  }
  #menu-toggle ~ .menu li {
    height: 0;
    margin: 0;
    padding: 0;
    border: 0;
	vertical-align: middle;
    transition: height 400ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  #menu-toggle:checked ~ .menu li {
    border: 1px solid #333;
    height: 1.3em;
	vertical-align: middle;
    padding: 1em;
    transition: height 400ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  .menu > li {
    display: flex;
	font-size: 16px;
    justify-content: center;
	vertical-align: middle;
    margin-top: 0;
	margin-bottom: 0;
	margin-left: 0;
	margin-right: 0;
    padding: 0.5em 0.5em 0.5em 0.5em;
	padding-top: 10px;
    width: 100%;
    color: white;
    background-color: #222;
  }
  .menu > li:not(:last-child) {
    border-bottom: 1px solid #444;
  }
}






.textrotation {
transform: rotate(+90deg);
width: 14px;
height: 120px;
}


a.whitelink {
color:#f0f0f0;
text-decoration:underline;
}

a.whitelink:visited {
color:#f0f0f0;
text-decoration:underline;
}




    .autocomplete-suggestions { border: 1px solid #999; font-size: 14px; background: #FFFFFF; line-height:20px; overflow: auto; }
	.autocomplete-suggestions strong { font-size: 14px; font-weight: normal; color: #3399FF; }




	.autocomplete-suggestion { padding: 2px 5px; white-space: nowrap; overflow: hidden; line-height:20px;}
	.autocomplete-selected { background: #F0F0F0; }
	.autocomplete-group { padding: 2px 5px; }
	.autocomplete-group strong { display: block; border-bottom: 1px solid #000; }




#PegfluYpSUFz {
display: none;
margin-top: 0px;
margin-bottom: 20px;
line-height: 35px;
font-size: 17px;
padding: 18px 8px;
background: #444444;
text-align: center;
font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
color: #fff;
border-radius: 5px;
 }

#PegfluYpSUFz2 {
display: none;
margin-top: 0px;
margin-bottom: 20px;
line-height: 18px;
font-size: 15px;
padding: 18px 8px;
background: #444444;
text-align: center;
font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
color: #fff;
border-radius: 5px;
 }



/* The Modal (background) */
.modal {
  display: none; /* Hidden by default */
  position: fixed; /* Stay in place */
  z-index: 1; /* Sit on top */
  left: 0;
  top: 0;
  width: 100%; /* Full width */
  height: 100%; /* Full height */
  overflow: auto; /* Enable scroll if needed */
  background-color: rgb(0,0,0); /* Fallback color */
  background-color: rgba(0,0,0,0.4); /* Black w/ opacity */
  -webkit-animation-name: fadeIn; /* Fade in the background */
  -webkit-animation-duration: 0.4s;
  animation-name: fadeIn;
  animation-duration: 0.4s
}

/* Modal Content */
.modal-content {
  position: fixed;
  bottom: 0;
  background-color: #fefefe;
  width: 100%;
  -webkit-animation-name: slideIn;
  -webkit-animation-duration: 0.4s;
  animation-name: slideIn;
  animation-duration: 0.4s
}

/* The Close Button */
.close {
  color: white;
  float: right;
  font-size: 28px;
  font-weight: bold;
}

.close:hover,
.close:focus {
  color: #000;
  text-decoration: none;
  cursor: pointer;
}

.modal-header {
  padding: 12px 16px;
  background-color: #5cb85c;
}

.modal-body {padding: 2px 16px;}

.modal-footer {
  padding: 2px 16px;
  background-color: #5cb85c;
}

/* Add Animation */
@-webkit-keyframes slideIn {
  from {bottom: -300px; opacity: 0} 
  to {bottom: 0; opacity: 1}
}

@keyframes slideIn {
  from {bottom: -300px; opacity: 0}
  to {bottom: 0; opacity: 1}
}

@-webkit-keyframes fadeIn {
  from {opacity: 0} 
  to {opacity: 1}
}

@keyframes fadeIn {
  from {opacity: 0} 
  to {opacity: 1}
}










.signBut {
      width: 30px;
      margin-bottom: 5px;
    }

.inNum {width: 40px;}








/* 1. Only hide child rows if they DON'T have the 'is-expanded' class */
/* This allows your 'Featured' leagues to stay visible on load */
table.detail tr.child:not(.is-expanded) {
    display: none !important;
}

/* 2. Show the row if it HAS the class */
table.detail tr.child.is-expanded {
    display: table-row !important;
}

/* 3. Style for the league headers */
table.detail tr.parent {
    cursor: pointer;
    user-select: none;
}

table.detail tr.child {
    /* This ensures that when they appear, they don't overlap borders */
    transition: opacity 0.2s ease-in-out;
}






</style>
















<script type="text/javascript">  
  window.__tcfapi('addEventListener', 2, function(tcData, listenerSuccess) {
  if (listenerSuccess) {
      if (tcData.eventStatus === 'useractioncomplete' ||
          tcData.eventStatus === 'tcloaded') {

         window.__tcfapi('getNonIABVendorConsents',2,function(nonIabConsent, nonIabSuccess) {
           if (nonIabSuccess && nonIabConsent.nonIabVendorConsents && nonIabConsent.nonIabVendorConsents[1]) {
			// console.log("Non-IAB vendor with id 1 has consent.");
			setCookie("vpl", 1, 2);
           } else {
		    // console.log("Non-IAB vendor with id 1 does not have consent.");
			// setCookie("vpl", 0, 2);
			setCookie("vpl", 1, 2);
		   }
         });
      }
   }
});
</script> 










	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=2, minimum-scale=1" />

<title>Premier League corner stats</title>       

<meta name="keywords" content="stats, football, soccer, statistics" />

<meta name="description" content="English Premier League stats" />

<meta property="og:locale" content="en_GB" />
<meta property="og:site_name" content="SoccerSTATS.com" />
<meta property="og:title" content="Premier League corner stats" />
<meta property="og:type" content="article" />
<meta property="og:image" content="https://www.soccerstats.com/img/own/sshp/sshp_220x116.png" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="200" />
<meta property="og:image:height" content="116" />
<meta property="og:image:alt" content="SoccerSTATS.com: football statistics and results" />

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@soccerstatscom" />
<meta name="twitter:title" content="Premier League corner stats" />
<meta name="twitter:domain" content="soccerstats.com" />


<meta property="article:tag" content="Premier League" />

<meta property="og:description" content="English Premier League stats" />

<meta property="og:url" content="https://www.soccerstats.com/table.asp?league=england&tid=cr" />
<link rel="canonical" href="https://www.soccerstats.com/table.asp?league=england&tid=cr" />



<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">


<link rel="manifest" href="/manifest.json">
































<SCRIPT type="text/javascript">

function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        let date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    const cookieValueString = (value === null || value === undefined) ? "" : String(value);
    document.cookie = name + "=" + cookieValueString + expires + "; path=/";
}

function getCookie(name) {
    let nameEQ = name + "=";
    let ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) {
            return c.substring(nameEQ.length, c.length);
        }
    }
    return null;
}

function TimezoneDetect(){
    let dtDate = new Date('1/1/' + (new Date()).getUTCFullYear());
    let intOffset = 10000;
    let intMonth;

    for (intMonth = 0; intMonth < 12; intMonth++){
        dtDate.setUTCMonth(intMonth);
        let currentOffset = dtDate.getTimezoneOffset() * (-1);
        if (intOffset > currentOffset){
            intOffset = currentOffset;
        }
    }
    return intOffset;
}

function checkCookie() {
    let tzoffset = getCookie("tz");

    if (tzoffset === null || tzoffset === "") {
        let detectedTzOffset = TimezoneDetect();
        if (detectedTzOffset !== null && detectedTzOffset !== undefined) {
            setCookie("tz", detectedTzOffset, 2);
        }
    }
}











function delete_cookie(name) {
  document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:01 GMT;';
}



function checkCookieMmode() {
    var themmode = getCookie("mmode");
    if (themmode != "") {

    
    
    } else {

        
        setCookie("tzz", "1", 2);
    }
}




</script>
















		<SCRIPT type="text/javascript">
			checkCookie();
		</SCRIPT>		


<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"Website",
  "name":"SoccerSTATS.com",
  "url":"https://www.soccerstats.com/",
  "description":"Soccer (football) statistics and results",
  "inLanguage": {
	"@type":"Language",
	"name":"en"
  }  
}
</script>







<script>(function(){/*

 Copyright The Closure Library Authors.
 SPDX-License-Identifier: Apache-2.0
*/
'use strict';var aa=function(a){var b=0;return function(){return b<a.length?{done:!1,value:a[b++]}:{done:!0}}},ba="function"==typeof Object.create?Object.create:function(a){var b=function(){};b.prototype=a;return new b},k;if("function"==typeof Object.setPrototypeOf)k=Object.setPrototypeOf;else{var m;a:{var ca={a:!0},n={};try{n.__proto__=ca;m=n.a;break a}catch(a){}m=!1}k=m?function(a,b){a.__proto__=b;if(a.__proto__!==b)throw new TypeError(a+" is not extensible");return a}:null}
var p=k,q=function(a,b){a.prototype=ba(b.prototype);a.prototype.constructor=a;if(p)p(a,b);else for(var c in b)if("prototype"!=c)if(Object.defineProperties){var d=Object.getOwnPropertyDescriptor(b,c);d&&Object.defineProperty(a,c,d)}else a[c]=b[c];a.v=b.prototype},r=this||self,da=function(){},t=function(a){return a};var u;var w=function(a,b){this.g=b===v?a:""};w.prototype.toString=function(){return this.g+""};var v={},x=function(a){if(void 0===u){var b=null;var c=r.trustedTypes;if(c&&c.createPolicy){try{b=c.createPolicy("goog#html",{createHTML:t,createScript:t,createScriptURL:t})}catch(d){r.console&&r.console.error(d.message)}u=b}else u=b}a=(b=u)?b.createScriptURL(a):a;return new w(a,v)};var A=function(){return Math.floor(2147483648*Math.random()).toString(36)+Math.abs(Math.floor(2147483648*Math.random())^Date.now()).toString(36)};var B={},C=null;var D="function"===typeof Uint8Array;function E(a,b,c){return"object"===typeof a?D&&!Array.isArray(a)&&a instanceof Uint8Array?c(a):F(a,b,c):b(a)}function F(a,b,c){if(Array.isArray(a)){for(var d=Array(a.length),e=0;e<a.length;e++){var f=a[e];null!=f&&(d[e]=E(f,b,c))}Array.isArray(a)&&a.s&&G(d);return d}d={};for(e in a)Object.prototype.hasOwnProperty.call(a,e)&&(f=a[e],null!=f&&(d[e]=E(f,b,c)));return d}
function ea(a){return F(a,function(b){return"number"===typeof b?isFinite(b)?b:String(b):b},function(b){var c;void 0===c&&(c=0);if(!C){C={};for(var d="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(""),e=["+/=","+/","-_=","-_.","-_"],f=0;5>f;f++){var h=d.concat(e[f].split(""));B[f]=h;for(var g=0;g<h.length;g++){var l=h[g];void 0===C[l]&&(C[l]=g)}}}c=B[c];d=Array(Math.floor(b.length/3));e=c[64]||"";for(f=h=0;h<b.length-2;h+=3){var y=b[h],z=b[h+1];l=b[h+2];g=c[y>>2];y=c[(y&3)<<
4|z>>4];z=c[(z&15)<<2|l>>6];l=c[l&63];d[f++]=""+g+y+z+l}g=0;l=e;switch(b.length-h){case 2:g=b[h+1],l=c[(g&15)<<2]||e;case 1:b=b[h],d[f]=""+c[b>>2]+c[(b&3)<<4|g>>4]+l+e}return d.join("")})}var fa={s:{value:!0,configurable:!0}},G=function(a){Array.isArray(a)&&!Object.isFrozen(a)&&Object.defineProperties(a,fa);return a};var H;var J=function(a,b,c){var d=H;H=null;a||(a=d);d=this.constructor.u;a||(a=d?[d]:[]);this.j=d?0:-1;this.h=null;this.g=a;a:{d=this.g.length;a=d-1;if(d&&(d=this.g[a],!(null===d||"object"!=typeof d||Array.isArray(d)||D&&d instanceof Uint8Array))){this.l=a-this.j;this.i=d;break a}void 0!==b&&-1<b?(this.l=Math.max(b,a+1-this.j),this.i=null):this.l=Number.MAX_VALUE}if(c)for(b=0;b<c.length;b++)a=c[b],a<this.l?(a+=this.j,(d=this.g[a])?G(d):this.g[a]=I):(d=this.l+this.j,this.g[d]||(this.i=this.g[d]={}),(d=this.i[a])?
G(d):this.i[a]=I)},I=Object.freeze(G([])),K=function(a,b){if(-1===b)return null;if(b<a.l){b+=a.j;var c=a.g[b];return c!==I?c:a.g[b]=G([])}if(a.i)return c=a.i[b],c!==I?c:a.i[b]=G([])},M=function(a,b){var c=L;if(-1===b)return null;a.h||(a.h={});if(!a.h[b]){var d=K(a,b);d&&(a.h[b]=new c(d))}return a.h[b]};J.prototype.toJSON=function(){var a=N(this,!1);return ea(a)};
var N=function(a,b){if(a.h)for(var c in a.h)if(Object.prototype.hasOwnProperty.call(a.h,c)){var d=a.h[c];if(Array.isArray(d))for(var e=0;e<d.length;e++)d[e]&&N(d[e],b);else d&&N(d,b)}return a.g},O=function(a,b){H=b=b?JSON.parse(b):null;a=new a(b);H=null;return a};J.prototype.toString=function(){return N(this,!1).toString()};var P=function(a){J.call(this,a)};q(P,J);function ha(a){var b,c=(a.ownerDocument&&a.ownerDocument.defaultView||window).document,d=null===(b=c.querySelector)||void 0===b?void 0:b.call(c,"script[nonce]");(b=d?d.nonce||d.getAttribute("nonce")||"":"")&&a.setAttribute("nonce",b)};var Q=function(a,b){b=String(b);"application/xhtml+xml"===a.contentType&&(b=b.toLowerCase());return a.createElement(b)},R=function(a){this.g=a||r.document||document};R.prototype.appendChild=function(a,b){a.appendChild(b)};var S=function(a,b,c,d,e,f){try{var h=a.g,g=Q(a.g,"SCRIPT");g.async=!0;g.src=b instanceof w&&b.constructor===w?b.g:"type_error:TrustedResourceUrl";ha(g);h.head.appendChild(g);g.addEventListener("load",function(){e();d&&h.head.removeChild(g)});g.addEventListener("error",function(){0<c?S(a,b,c-1,d,e,f):(d&&h.head.removeChild(g),f())})}catch(l){f()}};var ia=r.atob("aHR0cHM6Ly93d3cuZ3N0YXRpYy5jb20vaW1hZ2VzL2ljb25zL21hdGVyaWFsL3N5c3RlbS8xeC93YXJuaW5nX2FtYmVyXzI0ZHAucG5n"),ja=r.atob("WW91IGFyZSBzZWVpbmcgdGhpcyBtZXNzYWdlIGJlY2F1c2UgYWQgb3Igc2NyaXB0IGJsb2NraW5nIHNvZnR3YXJlIGlzIGludGVyZmVyaW5nIHdpdGggdGhpcyBwYWdlLg=="),ka=r.atob("RGlzYWJsZSBhbnkgYWQgb3Igc2NyaXB0IGJsb2NraW5nIHNvZnR3YXJlLCB0aGVuIHJlbG9hZCB0aGlzIHBhZ2Uu"),la=function(a,b,c){this.h=a;this.j=new R(this.h);this.g=null;this.i=[];this.l=!1;this.o=b;this.m=c},V=function(a){if(a.h.body&&!a.l){var b=
function(){T(a);r.setTimeout(function(){return U(a,3)},50)};S(a.j,a.o,2,!0,function(){r[a.m]||b()},b);a.l=!0}},T=function(a){for(var b=W(1,5),c=0;c<b;c++){var d=X(a);a.h.body.appendChild(d);a.i.push(d)}b=X(a);b.style.bottom="0";b.style.left="0";b.style.position="fixed";b.style.width=W(100,110).toString()+"%";b.style.zIndex=W(2147483544,2147483644).toString();b.style["background-color"]=ma(249,259,242,252,219,229);b.style["box-shadow"]="0 0 12px #888";b.style.color=ma(0,10,0,10,0,10);b.style.display=
"flex";b.style["justify-content"]="center";b.style["font-family"]="Roboto, Arial";c=X(a);c.style.width=W(80,85).toString()+"%";c.style.maxWidth=W(750,775).toString()+"px";c.style.margin="24px";c.style.display="flex";c.style["align-items"]="flex-start";c.style["justify-content"]="center";d=Q(a.j.g,"IMG");d.className=A();d.src=ia;d.style.height="24px";d.style.width="24px";d.style["padding-right"]="16px";var e=X(a),f=X(a);f.style["font-weight"]="bold";f.textContent=ja;var h=X(a);h.textContent=ka;Y(a,
e,f);Y(a,e,h);Y(a,c,d);Y(a,c,e);Y(a,b,c);a.g=b;a.h.body.appendChild(a.g);b=W(1,5);for(c=0;c<b;c++)d=X(a),a.h.body.appendChild(d),a.i.push(d)},Y=function(a,b,c){for(var d=W(1,5),e=0;e<d;e++){var f=X(a);b.appendChild(f)}b.appendChild(c);c=W(1,5);for(d=0;d<c;d++)e=X(a),b.appendChild(e)},W=function(a,b){return Math.floor(a+Math.random()*(b-a))},ma=function(a,b,c,d,e,f){return"rgb("+W(Math.max(a,0),Math.min(b,255)).toString()+","+W(Math.max(c,0),Math.min(d,255)).toString()+","+W(Math.max(e,0),Math.min(f,
255)).toString()+")"},X=function(a){a=Q(a.j.g,"DIV");a.className=A();return a},U=function(a,b){0>=b||null!=a.g&&0!=a.g.offsetHeight&&0!=a.g.offsetWidth||(na(a),T(a),r.setTimeout(function(){return U(a,b-1)},50))},na=function(a){var b=a.i;var c="undefined"!=typeof Symbol&&Symbol.iterator&&b[Symbol.iterator];b=c?c.call(b):{next:aa(b)};for(c=b.next();!c.done;c=b.next())(c=c.value)&&c.parentNode&&c.parentNode.removeChild(c);a.i=[];(b=a.g)&&b.parentNode&&b.parentNode.removeChild(b);a.g=null};var pa=function(a,b,c,d,e){var f=oa(c),h=function(l){l.appendChild(f);r.setTimeout(function(){f?(0!==f.offsetHeight&&0!==f.offsetWidth?b():a(),f.parentNode&&f.parentNode.removeChild(f)):a()},d)},g=function(l){document.body?h(document.body):0<l?r.setTimeout(function(){g(l-1)},e):b()};g(3)},oa=function(a){var b=document.createElement("div");b.className=a;b.style.width="1px";b.style.height="1px";b.style.position="absolute";b.style.left="-10000px";b.style.top="-10000px";b.style.zIndex="-10000";return b};var L=function(a){J.call(this,a)};q(L,J);var qa=function(a){J.call(this,a)};q(qa,J);var ra=function(a,b){this.l=a;this.m=new R(a.document);this.g=b;this.i=K(this.g,1);b=M(this.g,2);this.o=x(K(b,4)||"");this.h=!1;b=M(this.g,13);b=x(K(b,4)||"");this.j=new la(a.document,b,K(this.g,12))};ra.prototype.start=function(){sa(this)};
var sa=function(a){ta(a);S(a.m,a.o,3,!1,function(){a:{var b=a.i;var c=r.btoa(b);if(c=r[c]){try{var d=O(P,r.atob(c))}catch(e){b=!1;break a}b=b===K(d,1)}else b=!1}b?Z(a,K(a.g,14)):(Z(a,K(a.g,8)),V(a.j))},function(){pa(function(){Z(a,K(a.g,7));V(a.j)},function(){return Z(a,K(a.g,6))},K(a.g,9),K(a.g,10),K(a.g,11))})},Z=function(a,b){a.h||(a.h=!0,a=new a.l.XMLHttpRequest,a.open("GET",b,!0),a.send())},ta=function(a){var b=r.btoa(a.i);a.l[b]&&Z(a,K(a.g,5))};(function(a,b){r[a]=function(c){for(var d=[],e=0;e<arguments.length;++e)d[e-0]=arguments[e];r[a]=da;b.apply(null,d)}})("__h82AlnkH6D91__",function(a){"function"===typeof window.atob&&(new ra(window,O(qa,window.atob(a)))).start()});}).call(this);

window.__h82AlnkH6D91__("WyJwdWItMzkxMDUzOTM2MzczMTUzMiIsW251bGwsbnVsbCxudWxsLCJodHRwczovL2Z1bmRpbmdjaG9pY2VzbWVzc2FnZXMuZ29vZ2xlLmNvbS9iL3B1Yi0zOTEwNTM5MzYzNzMxNTMyIl0sbnVsbCxudWxsLCJodHRwczovL2Z1bmRpbmdjaG9pY2VzbWVzc2FnZXMuZ29vZ2xlLmNvbS9lbC9BR1NLV3hVWWN6X1NWVHJSSjFEQU5jeDN2WjdjbDh6Q1cwMHQ1OGROSXRQOXpMcGhsVGlzWFpCRENRcWZwMEtNYUZUN3hZVDhYc1Z3MXdHQUJrdkYxT0hvM1o1RDZ3XHUwMDNkXHUwMDNkP3RlXHUwMDNkVE9LRU5fRVhQT1NFRCIsImh0dHBzOi8vZnVuZGluZ2Nob2ljZXNtZXNzYWdlcy5nb29nbGUuY29tL2VsL0FHU0tXeFVib05kVmxQek81NGZsRUh0akhzRHFHQk4wcnVVZzNZMmFEcFlCSzFvRnVQak1ubjRkelA0M1RhdFdKR2I2SU9JRHhGYmJyME14R2k4UlRPU0ozVWluekFcdTAwM2RcdTAwM2Q/YWJcdTAwM2QxXHUwMDI2c2JmXHUwMDNkMSIsImh0dHBzOi8vZnVuZGluZ2Nob2ljZXNtZXNzYWdlcy5nb29nbGUuY29tL2VsL0FHU0tXeFVrV1Fia0hWQmNCOF96c281Y0g2UWxwVmMzRVFtVEwtOGZpTTB4LV9JOU5KODZsckpWbnNJeXdvMnZyaGZ6SDFCdUJjN25HeTRiZjk1bElnTVVna3pMV1FcdTAwM2RcdTAwM2Q/YWJcdTAwM2QyXHUwMDI2c2JmXHUwMDNkMSIsImh0dHBzOi8vZnVuZGluZ2Nob2ljZXNtZXNzYWdlcy5nb29nbGUuY29tL2VsL0FHU0tXeFZiOGFienNoR1dZbTk3RGRvN3hLVHREZk5mdzhwMXBWY3ZMSEEzZjdYQldoM3lMcVp6dzR0S0NsclQ3Y0wybXJkQjBybGNoS3QxNEllUEZIdGNUN0xXNUFcdTAwM2RcdTAwM2Q/c2JmXHUwMDNkMiIsImRpdi1ncHQtYWQiLDIwLDEwMCwiY0hWaUxUTTVNVEExTXprek5qTTNNekUxTXpJXHUwMDNkIixbbnVsbCxudWxsLG51bGwsImh0dHBzOi8vd3d3LmdzdGF0aWMuY29tLzBlbW4vZi9wL3B1Yi0zOTEwNTM5MzYzNzMxNTMyLmpzP3VzcXBcdTAwM2RDQWciXSwiaHR0cHM6Ly9mdW5kaW5nY2hvaWNlc21lc3NhZ2VzLmdvb2dsZS5jb20vZWwvQUdTS1d4Vk42emE2eHQ2UFJnV0xOaGZJYk5pSDhrM29NTk92R2NES2d2LVl6SFlUWWFKclM3ZDc1cHFzTjh5TW5TX3VJMjYzT0g1dnZkTWNIb1psSWgxeWN4STlwUVx1MDAzZFx1MDAzZCJd");</script>

<script type="text/javascript" src="https://steadyhq.com/widget_loader/92742d22-22e3-4569-8c18-62fae6e21b7d"></script>







</head>










<body class="ver1" style="background-color:#e8e8e8;position:relative;"> 







 


<div id="testdivid" style="width:2px;"></div>



<script async src="https://fundingchoicesmessages.google.com/i/pub-3910539363731532?ers=1" nonce="4m5_6C3kVngKB0-2fdRsPw"></script><script nonce="4m5_6C3kVngKB0-2fdRsPw">(function() {function signalGooglefcPresent() {if (!window.frames['googlefcPresent']) {if (document.body) {const iframe = document.createElement('iframe'); iframe.style = 'width: 0; height: 0; border: none; z-index: -1000; left: -1000px; top: -1000px;'; iframe.style.display = 'none'; iframe.name = 'googlefcPresent'; document.body.appendChild(iframe);} else {setTimeout(signalGooglefcPresent, 0);}}}signalGooglefcPresent();})();</script>
<div id='abovetopdiv' style='margin:1px;height:2px;'></div><div id='topdiv' style='margin-left:26px;background-color:#e8e8e8;border-bottom:3px;solid #dddddd;padding-left:9px;display: flex;'><div id='insidetopdiv' style='background-color:#ffffff;width:990px;height:18px;padding-top:1px;text-align:right;vertical-align:bottom;display: flex;justify-content: right;margin-left:0px;'><table cellspacing='3' cellpadding='0' bgcolor='#ffffff' width='100%' style='padding-left:2px;border: 1px solid #ffffff;'><tr height='32'><td align='left' width='230'><a href='//www.soccerstats.com'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAAAeCAYAAABpP1GsAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAevSURBVHhe7ZqJVhRHFIZ9kDxBHiLvELN5sqhRxBUXQEWUIO5L3PejKCAQEcXgigsiBCS4gAiisuMWEYFxFraBuem/uqq7pml6esjxnAnUd04dmep/arq679/3VrUzSKFQTIgyiELhgDKIQuGAMohC4cA4g3x1eaZjUyimE8ogCoUDyiAKhQPKIAqFA8ogCoUDyiAKhQOfzSBf5v0TsSkUsY4yiELhgDKIQuFAzBqk69VbOngsi1at3Uy/LkqmFas30vY9R+nmnQr65PVx1dQi0pxPZObRz/NXRmy3Siv4iCZFl0vCNA8f1/MjJpMZf6rfp0kZ5N2MLxwbsDOEtU3Ek6dNNHtBou3NQevofM2VUwc3c/4vBklO3Rqm2X8kkx8xiXb86XCfYtIg6zN2sws8R7v4d8vvU1tHFz149IQyswto9/4TXDW1cDPnvj4PvX7zjjU8uUUgrl6/zehH8/kDTC9obes0tJt3HGT/zl2YNE4X7fjT4T7FpEHmLV7DLvzatB28Z2K8WhrPPXeJElO2sJsevyyFpfinjc+5IhyPx0s5+UVcn0wLE1IpbdMeunztNlfoRKPLyi3USosMmhOfRItXrNeezqep89UbrtDJL/iTzWnvoVMUGBjUvnOBlqzcwOY6Ojoa1ZzB6NgY06OlbtzFe+3JzrvIdJhHe8cr43ulZVVcMR4340d7zlb6B0J0smaQFl3w0/dnvfTzHz5KuuKnC/VDXKHjGQxR5gNd912Ol37K91H6zQDVvh3lCpPTDwfp6ywvpVwPUM2rIK29FqBZuV42/uKLfip4MkSvPWO0o2yAZp/z0Q9a/7IiPxU/G6ZQiA8iEZMGwRMLF/6XuFV049Y9GtNulh19/R5W84obaW3Xb5Zxpc7H3n5KSEq31e47bJYcbnV44iYk2+tQjze3tnOlaZD4hHWUvnWfocNn4HbOArcGgQ6mhW7XvuOsb82G7exzxrYD7LMdbsaP9pxlevwhml/gY8FsbdvvDnAVUW8gRAvO2+vQihuHuVJHGGQyreRl+FggJg1SVlFt3By0xJTNVHqvij1pZY6cyDE0p7LOsYCseVhnBDdu3Nt377ma6PDxbEN/6HgWvWhuY5kGmaLh2Quucq+Tf7/g4lVqbe+i6ge1LDOgb8Om37nSNAgazgtZr+lFC7Vo5Q9wO2eBW4PU1jcaOpExzhddNfq6P/SwPituxo/2nGV23xswAnOX9ndj9yjLCMgodVJm2FNu6g5XDdLzD6NU2TFimGtmtpdlBIFsEGSau60j1KSNnaxlJtGPlvVoiI0l61NvhJecICYNAm7eKddS+OqwG7BGe2KhNgbBIMoS/fjy5I1aejTzY0VljfEdBAPQyxhdv3RVGvu+HdHp9BLDWqPDSOL3+z2fmF42CMxhR6Q5y7g1iDA7TImMC9o7zTKrqLiE9VlxO3405ywIavGM0gZBOVcLdHy2Q9bFaVlELoHutAwbgX221izJ5IAvajD7q7uCRv+qYj/vxTyJlWDoX1A4ftctZg0CEFwIpvlL9EBEW6SVC/5AgHo+9hl9onQQoP4Xxw4ePcP6ZP3OvcdYnx2T0Tk1BCOQDSJnIStOc5ZxE8AD2lpHBO/KNRlU3/DcaHFL17L+pHVbuDoctwYBbs9Z8MEXMoJ14y17DZB1GbfDde19Y8axndp6QiAb5Mk78+GGbCH6D1YO8l4dGAP9MKuVmDaIAAth1Mvi4iONhweyxSBdkkGOZbG+np5eSe8Q+G51Lg0iSijZIKLPCbs5y7gJ4HIpkzq1ltYO/g2TaAwiiHTOgm6fGdyuDWLRtfWaY6BEE8gGeaGZQoC/Rf8pbcEvE/9/MghKmmAwyD+ZPK5rMC48ygKUOOKJtSzxN3ZDBff++tvQihJrZCTItiPR51Q6udXJJVba5j28d2KcDOJ2zjJuAnjb7iOGxqmdOVvIv2ESafzJnLNgWLuk3+bowRqpxJqVqwfvPK3EQjkkuN0cucSakgZ5391Di5ansr30qupH7OmGxeyWXYeMC/+o9inTYmEu+vCS62WLvkiHYUS/XAtj+1f0ozZ/qS2+G5tesq3bnPyLXOVed+xkrqE7cTqfnSdKKpQwV67foZLb5VzpbJBo5iyIFMC9ff1s3YHjWBNYwYMgboleZuG3rQ+CSONHc855dUP0Y56PNpQEmDkAtmlFwGLB/kxbSNdrJRG2eLFQF2BhLnQHKgfYghuLdBhG9KPcEkwLg4gLbNew3hALctS42IO306EVFl1jOgFKL/HUtza8nxC41Xk+eVkNb6dDO3ryLFdGNoj8PWuT5yyIFMBXb5Qax0UWtYLyU2iiNWA05yxv5zZ/1IMZJZJYHFvbtlKzZPINhSjhUvgOlNxypewBprxBhoeH2dMXb3yxXYuXf0sT02iT9rmi6gG7cTJYiGKLFf+VAtoFy1LYUwxvdO3ALhOyAson/DcJlGn4LTz1Zdzq8NIPRoRRsSCGsbDdiS1gZDSBk0GinTOIFMDr0ncax/Fy0I77NY8NDV5uykQaP5pzRgbBbtS662YGAV39Yyx7IDC/yfaycipV09S+Cc9mgZEQ5WhGwIs+vChENlp/I0D3O0e4wuSzG0ShUJgogygUDiiDKBQOKIMoFBNC9C+UMntWtQjxxwAAAABJRU5ErkJggg=='/></a></td><td align='right'>











	<table cellspacing='3' cellpadding='0' bgcolor='#ffffff' width='100%' style='border: 1px solid #ffffff;'>
	<tr height='32'>            

	<td align='center' valign='middle' style='padding-top:1px;'>
	<a class='vsmall' href='//www.soccerstats.com/leagues.asp' style='width:66px;font-size:13px;color:#000000;font-weight:normal;padding:5px;padding-left:5px;padding-right:5px;padding-bottom:5px;' title='League statistics'>LEAGUES</a>
	</td>
	
	
	
	
	<td align='center' valign='middle' style='padding-top:1px;padding-left:6px;'>
	<a class='vsmall' href='//www.soccerstats.com/matches.asp' style='width:66px;font-size:13px;color:#000000;font-weight:normal;padding:5px;padding-left:5px;padding-right:5px;padding-bottom:5px;' title='Match overview'>MATCHES</a>
	</td>

	<td align='center' valign='middle' style='padding-top:1px;padding-left:6px;'>
	<a class='vsmall' href='//www.soccerstats.com/stats.asp' style='width:66px;font-size:13px;color:#000000;font-weight:normal;padding:5px;padding-left:5px;padding-right:5px;padding-bottom:5px;' title='Statistics'>STATS</a>
	</td>





		

		<td align='center' valign='middle' style='padding-top:1px;padding-left:6px;'>
		<a class='vsmall' href='//www.soccerstats.com/favourites.asp' style='width:66px;font-size:13px;color:#000000;font-weight:normal;padding:5px;padding-left:5px;padding-right:5px;padding-bottom:5px;' title='Manage favourite leagues and matches'>FAV</a>
		</td>

		



	<td align='center' valign='middle' style='padding-top:1px;padding-left:6px;'>
	<a class='vsmall' href='//www.soccerstats.com/blog.asp' style='width:66px;font-size:13px;color:#000000;font-weight:normal;padding:5px;padding-left:5px;padding-right:5px;padding-bottom:5px;' title='Blog'>BLOG</a>
	</td>


	<td align='center' valign='middle' style='background-color:#ffffff;' width='5'></td>

    <td align='center' valign='middle' style='background-color:#ffffff;' width='10'></td>





	<td style='vertical-align:top;width:200px;'>


	<div class="dropdown" style="margin-top:1px;background-color:#f0f0f0;border:1px solid #aaaaaa;border-radius:4px;padding-top:1px;padding-bottom:0px;float:left;">
		<button class="dropbtn" style="height:26px;margin-bottom:1px;background-color:#f0f0f0;"><font color="#000000">
Premier League		
		</font><font color="#AAAAAA">&#9660;</font></button>


		<div class="dropdown-content" style="left:0;width:200px;background-color:#f8f8f8;">

		<br>&nbsp;<font style="color:#444444;font-weight:bold;">Favourite leagues</font>
		<br>&nbsp;-------------------------------

		<br>&nbsp;<font style="color:#444444;font-weight:bold;">My Favourites</font>
		<br>&nbsp;-------------------------------
		<a href="favourites.asp#fleagues">Select favourites</a>

		<br>&nbsp;<font style="color:#444444;font-weight:bold;">Featured leagues</font>
		<br>&nbsp;-------------------------------
        <a href="latest.asp?league=england">ENG - Premier League</a>
        <a href="latest.asp?league=italy">ITA - Serie A</a>
        <a href="latest.asp?league=spain">SPA - La Liga</a>
        <a href="latest.asp?league=france">FRA - Ligue 1</a>
        <a href="latest.asp?league=germany">GER - Bundesliga</a>

		<br>&nbsp;<font style="color:#444444;font-weight:bold;">All leagues</font>
		<br>&nbsp;-------------------------------
        <a href="#">See 'Search league' box</a>
        <a href="leagues.asp">Display all leagues</a>

		<br>&nbsp;<font style="color:#444444;font-weight:bold;">International (clubs)</font>
		<br>&nbsp;-------------------------------
        <a href="leagueview.asp?league=cleague">Champions League</a>
        <a href="leagueview.asp?league=uefa">Europa League</a>
        <a href="leagueview.asp?league=uefaconference">Conference League</a>
        <a href="leagueview.asp?league=copalibertadores">Copa Libertadores</a>
        <a href="leagueview.asp?league=copasudamericana">Copa Sudamericana</a>
        <a href="leagueview.asp?league=clubworldcup">FIFA Club World Cup</a>
        <a href="leagueview.asp?league=cleaguew">Champions League (W)</a>

		<br>&nbsp;<font style="color:#444444;font-weight:bold;">International (nations)</font>
		<br>&nbsp;-------------------------------
        <a href="leagueview.asp?league=euro">EURO 2024</a>
        <a href="leagueview.asp?league=euroqual">Euro Qualification</a>
        <a href="leagueview.asp?league=nationsleague">UEFA Nations League</a>
        <a href="leagueview.asp?league=worldcup">World Cup 2026</a>
        <a href="leagueview.asp?league=fifaqual">WC Qualification Europe</a>
        <a href="leagueview.asp?league=fifaqualsa">WC Qual. South-America</a>
        <a href="leagueview.asp?league=fifaqualasia">WC Qualification Asia</a>
        <a href="leagueview.asp?league=copaamerica">Copa America</a>
        <a href="leagueview.asp?league=africacup">Africa Cup of Nations</a>
        <a href="leagueview.asp?league=asiancup">Asian Cup</a>
		<a href="leagueview.asp?league=worldcupw">Women's World Cup</a>
        <a href="leagueview.asp?league=eurow">Women's EURO 2025</a>


        </div>
    </div>


	</td>






	
	<td align='left' valign='middle' width='120' style='padding-top:1px;padding-left:4px;padding-right:2px;'>
	<a href='//www.soccerstats.com/members.asp' class='vsmall' style='width:30px;text-align:center;font-size:13px;background-color:#D9EBFD;color:#000000;font-weight:normal;padding:7px;padding-left:7px;padding-right:7px;padding-bottom:6px;' title='Members'>L</a>
	</td>
	 
<!-- Back to top button (top) -->
<a href="#" title="Back to top" style="position: fixed; top:10px;right:3px;font-size: 14px;font-weight: bold;z-index: 99;">
<img width="32" height="32" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAABhlBMVEUAAAAHFiAHGCMIGSUHFyEIGSUJHisKIjEIGSUJHCgNKTwOKz8TOFEUPFcUPVgVQFwWQV4XRWMRNU0SOVMZSmoaTG4bTnETPloUP1sZTnEaTG0aUncbUHQbUXQWRmUYSmskapkka5olbp8ZTnEaUncdVXoeWYEeWoEcVHkeWIAaT3IbU3geXYceYIoodqopea8cWYEcWoIhZ5UhaZcjb6EkcqQtg70uhsEuh8Miapoia5oldKgldaowjs0xj88xkNAkcqUmd60mea8ofLMpfrYpgbopgbs0mNspgLkpgLk0mNsvjcs0mNs0mNsshsI0mNspgLkqgrwqg74rhL8rhcEshsIsh8MsiMQsiMUuisgvh8Evjcsvjswwj84wkNAxktMylNYyldczltgzl9o0mNs2mds8nNw+jL9AjsJFnNVHod1XqN9ioclppctqsuFtqM5vst5xteKCveSGtdOSvNeVxeSdyue11eq/1uTI3+zL3efY5u7d5+zj6+/m7O/p7vDr7/Ds8PFqLrIUAAAAUHRSTlMAAQEBAgICAgMDDg4XFxcYGBgmJiYmJjIyPj4+Pj5GRkZGRklJUVFRUlJTU1lZW1tsbHl5h4eLi4uTk5iYoqKipqioqanOztzf6evv+/z9/nih35EAAAGYSURBVDjLrZNXVwIxEIVV7L333rD3gh0rImVBYQEVRRKKUgQEscP8cyHJ7iKsD57jPfuQmfttkkkmRUX/q7recWVf/W9u27qGwxlxGlW7jN24a8CiDHtN+f7QGf6hs+Gf/pwe50k/n+sPFvgZImeOBmn+WExaRdrHjpgMp1JhMdgT/FZx/4FPgM+AWItQ7ZqQeXiHjN4fhFjFAA2Lva9A9OplCQ31azkaepIAb+RLemiGo6fezfhngJdHgMcXgGeW6iPAGCsQ4MMfAYj4PwBYsUoCTLACIR28iQJEb4JpYMVOEmCKjBNfEHfgLIAdcfhKkOQ0AfpRdsz7ni4RBdDlk4/P5tAAAZpdJLi+uMMUwHcX1+QnVwsBynXSDVFAkK6CHsQhkgfQETvJEac84BxlQPGxWw5wnyiE6+wyokIAGXukjlmxM+I+FLpnvn01p+VK9610lVub7ZbObz0oy23Kyi2zU6oFI6d5uyqv72e051cuwiDX1bl2tvDlVC+dmswWnreYTafLNbJvr6RjYUOt3lzsVPzlPX8DFUDvMylY+zgAAAAASUVORK5CYII=" alt="back to top"></a>



</tr>
</table>





















</td></tr></table></div></div><div id='container-row' style='display: flex;margin-top:48px;margin-left:0px;'><div class='adcol1' style='height:4000px;min-width:10px;text-align:center;padding-left:1px;padding-right:18px;padding-top:410px;float:left;'></div><div class='body-text' style='float:left;'><div id='headerlocal'><div style='max-width:990px;'>

 	<!-- top bar desktop -->
	<div style="max-width:990px;background-color:#ffffff;text-align:left;border-top: 0px solid #ffffff;border-left: 0px solid #cccccc;border-bottom: 0px solid #cccccc;">
								
		<div style="background-color:#ffffff;height:40px;width:990px;padding-top:0px;padding-bottom:2px;float:left;">		










<table cellspacing='0' cellpadding='0' bgcolor='#ffffff' width='100%' style='padding-top:4px;padding-bottom:4px;padding-left:2px;'>
<tr class='trow2'>
<td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Argentina'><a href='latest.asp?league=argentina' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGMSURBVHjaYow8/v/LHwYI+Mfw7xcQ/2EACvz68+/Pv38//gBFQAjE+POPjYkBIIBYPv1hSFWEqP7//z/jv/9ABsO/f////mf8+4/5LwPT33//wVwQyj32BSCAWH78Yfj9j+H97/8gpf8ZQBJAS/7///MPjEBcKFuYnZHh1z+AAGKpl32jKSYM1PMfaMt/kDYgBBoJAmA+hAkkWRkZRLXfAAQQizrvP2E2BrBisFog/X3v3y+bgYYycXv+53D7DwOMjAxmwgwAAcQE8S5UDEL/2PPv3/3/f+/9/7b9PzIA+e0fQACxIKtmgOhgs2P48QYYTv85nJHVMwId9u8fQACxXPv4T4v3/6+/IB0w57r+53L5B5L+/+8rVPW/fwxsLP+PvvkLEEAsWbeFSpkZXn4HhgMDPED+wkPpHzSUgEEnwcnQeUQQIIBYmP79Y2RgEmWHBuhfYMiCdDICGX9A4Qt0NwM4TkB+APoCIIAYjbd+ffcLGpE/QAio+h9ILSjOwegPGAHjExj/bAwAAQYA9gFw522GQWAAAAAASUVORK5CYII=' alt='Argentina' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Argentina'><br><font style='font-size:11px;color:#222222;'>AR</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Austria'><a href='latest.asp?league=austria' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAElSURBVHjaYvzPgAD/UNlYEUAAmuTYAAAQhAEYqF/zFbe50RZ1cMmS9TLi0pJLRjZohAMTGFUN9HdnHgEE1sDw//+Tp0ClINW/f0NIKPoFJH/9//ULyGaUlQXaABBALAympv81tRhExYFWAI0BqQZZ8geE4Iw/f379+sUmLv5v+3aAAGJ8+fKlqKgo2Jb/DGCIBoBKISQ3N/fbt28BAgjiJKgqOAM7AMsCBBALQhFW85HV/weGyz+AAGL8ra/PWFj4//VrBiQXAwPq/18UbwBlGcXF37S1AQQQy7+LF5mPHft/7x4DNFigYQIlIYw/vxmAYa2iAnQOQACxAEOK6fcfBklJUIACRYFywBAEsf8wQEiw8RAEVAwQQIxfUSMSTxxDAECAAQAPfFda8rBeqAAAAABJRU5ErkJggg==' alt='Austria' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Austria'><br><font style='font-size:11px;color:#222222;'>AT</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Australia'><a href='latest.asp?league=australia' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAIzSURBVHjaYjxe3nyAQ6Vyx7veD+tY/v3L/+dWKvXIyUTOc9Ybhq8fGBj+AJFnssv2uZsYGN4xMPwCCAAxAM7/AUtNjZ95PPsXHfjPzf/49wEfIhAVELzd+MzU5v38/vf6+1tNLQQEAd7j77fB3KOMjwIAMQDO/wHNCQkZhYYD7Or78vL++fkFDAv5/gH29/qJCD3w/AH6+PodGQ9GOyGJm8UgHRGrko8CiOmQjg+Ttj6HluZfYVEGWQUuM7Pfsop3ZfR+/Pnv56jCwMBw4/5roOrKdBsJYW4Ghm8AAcT0ISSJQVh4wz+F5zziL1gF1gmZMevofuQTcbZTlRXnLUyy+P7jd4SXFisLo6uVIgPDD4AAADEAzv8DLAEa6w0YwN/4+/b43/UCuNbx2/QDEP73rcbkJSIUq7fV6ev07O/3EQ8IqLXU3NDDAgAxAM7/A8veKS1ELvXw9N77Cd76BwT8+ujr9M/o+/3//8bN4+nt9P///1dLK6Cu0QkIBd7RvgKICRRwf/79/vMvyF6pNsX81++/f/7+Y/j39/evP//+/fv/9//Pn3965hz7+Onbv79/gYoBAgio4devP0Dj/psbSMtJ8gW4afz89fvX7z9g9BcYrNISfOWpVj9///379z9QA0AAsQA1AE0S4ufceeSuvprowZMPZCX4fv4Eyv778+f/9x+/ihLNtZTFfv76u2bnNaCnAQKIkYHBFxydP4A6kdAfZK6qY9nt/U0MDP+AoQwQYAAK+BukFnf4xAAAAABJRU5ErkJggg==' alt='Australia' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Australia'><br><font style='font-size:11px;color:#222222;'>AU</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Belgium'><a href='latest.asp?league=belgium' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAFTSURBVHjaYmRABR/fM/D8AjH+/WP4J8Dw7xPDP3GGfwwIBBBALEC56upqsAoQ4OD6y8D3l4HhD+P/P8wMf5h4f/+P+fP/9+//f0Dkl02bAAKIBWzu/ydPnv4Fg3//fjMw/P3//zcU/f39//av/79+AVUzysoCbQAIIBaw2f+BSv8AEdCk/0DVv/7//wPW8AuEfv2GaGD4/RuoASCAQBpAqiHg9x+E2dg0ABUDBBBIw58/f3///o2k4RdCwz+waoiGP3+ANgAEEMQGkOJfv3+haoCRMBsYwU4CCCCQBqDxv379Alnw6xe6Df9/w40HBtQTBgaAAII4CehbKIC6G66aFazhD1DDX5BLGBgAAghiwx9JSUmwN/4yMgJ99htMAmWBHv3DoPQHqBSCgE4CCCBGtJi+fZfhFwsD0Hf//jAIcTD8e8fwQh8kDtTNxsBwh4EBIMAAr1pl7/uLhvQAAAAASUVORK5CYII=' alt='Belgium' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Belgium'><br><font style='font-size:11px;color:#222222;'>BE</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Brazil'><a href='latest.asp?league=brazil' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAHjSURBVHjaYmRIZkCAfwwMf2DkLzCCMyDoBwNAALEAlTVGN/5nYPj//x8Q/P3/9++/vzZa31gY/mw5z/Tn3x8g98+f37///fn99/eq2lUAAQTS8J/h/7NPz/9C5P79WRj89f9/zv//fztLvPVezPzrz+8/f3//+vtLhl8GaANAAIE1/P8PVA1U6qn7NVTqb1XVpAv/JH7/+a/848XmtpBlj39PO8gM1PP7z2+gqwACiAnoYpC9TF9nB34NVf5z4XpoZJbEjJKfWaEfL7KLlbaURKj8Opj08RfIVb+BNgAEEBPQW1L8P+b6/mb6//s/w+/+nc4F0/9P2cj65xdHc+p/QR39//9/AdHJ9A/60l8YvjIABBAT0JYH75jStv75zwCSMBY8BXTMxXv/21ezfHj9X5/3BESDy5JfBy7/ZuBnAAggkA1//vx594kpaCnLloe/smLaVT9/ff3y/+/P/w+u/+JuW7fhwS/tSayPXrOycrEyfGQACCAWoA1//oOCDIgm72fu4vy6b4LD/9/S/3///s9+S28yy+9/LEAf//kLChVgCAEEEEjD7z9/JHgkQeHwD8gUjV79O9r6CzPLv6lr1OUFwWH9Fxjcv//9BcYoA0AAMTI4ImIROUYRMf2XARkABBgA8kMvQf3q+24AAAAASUVORK5CYII=' alt='Brazil' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Brazil'><br><font style='font-size:11px;color:#222222;'>BR</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Switzerland'><a href='latest.asp?league=switzerland' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA8AAAALCAYAAACgR9dcAAAABGdBTUEAAK/INwWK6QAAAAlwSFlzAAAOxAAADsQBlSsOGwAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAEYSURBVChTbVJBjsIwDBy3aA8ceAwceAMrId6wfIMzH0H8gAPc+ciuxANWSN1SWmrsSUIpS9QosT3jsZ2KAvZ1q7Vr9mI/xxszHONLSF6taGhrbhH7pGczVtfA5YJsNGLsb73GIOQI4pJl0NMJersBmw1Ug18XC5Lz8ZjY+vuH6qxQW+VmEifafhAtgRP1asoJayfJqf4UoOJ2yzyegHu3gx72oci4utl4n1Yyy04EYz/u0cd5OCYpU9EGEfqOhDdEJoo4LYqubHemvnU+B2affdXpFDqZkMzZlOVTz42/XlhhONc+2e2qAiLOMd6zlIYffC2hjZH8LSEk5sPhP59Wpnw+E/d7PEIKf6k4gHR6BR9vfB5Pf5jf75tm/JHy7mWtAAAAAElFTkSuQmCC' alt='Switzerland' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Switzerland'><br><font style='font-size:11px;color:#222222;'>CH</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='CzechRepublic'><a href='latest.asp?league=czechrepublic' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAFuSURBVHjaYmSIP9sdIJLlJsIABv/+/YOQyAw4+PPvH0AAsQj++8LGK3vzxV8DRR6Inv//wQScQgIvXrwACCAmIOD+/2f1hS9Hrn+EqIArQzMeYiFAALEAGX///ef6+3PjlX9///2z0xL4jwNANAAEEMsfoLuAhv3/z/3357qLf//8/eegLYBLw58/fwACiOXXH7Bv/v7/+/c/59+fK87+Fd++WkmUDcj/9+cPkGT4C5b7+5dRQIAhLw8ggIA2AA0FCQL1/P77z/fCGplzG37++v3/16+/v0Hk/9+//4FJFiWlDz9/AgQQy98/QKeDlAI12J3faHduI1TR798Mv34xgPUASaBrQIiBASCAWBh+gawAqT630f48SDXEPLg2kMgfoAaQq4A6AAIIqAGk2uvZEdO35xmkpIFyTEDzgEqBHvj9mxFI/vnDDPMG0AaAAGJh+PHnWohxCMP7l8BQAyNQaMDYfyDRD2MwMTAABBgAMxl5E8UTSgsAAAAASUVORK5CYII=' alt='CzechRepublic' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='CzechRepublic'><br><font style='font-size:11px;color:#222222;'>CZ</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Germany - Bundesliga'><a href='latest.asp?league=germany' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGzSURBVHjaYvTxcWb4+53h3z8GZpZff/79+v3n/7/fDAz/GHAAgABi+f37e3FxOZD1Dwz+/v3z9y+E/AMFv3//+Qumfv9et241QACxMDExAVWfOHkJJAEW/gUEP0EQDn78+AHE/gFOQJUAAcQiy8Ag8O+fLFj1n1+/QDp+/gQioK7fP378+vkDqOH39x9A/RJ/gE5lAAhAYhzcAACCQBDkgRXRjP034R0IaDTZTFZn0DItot37S94KLOINerEcI7aKHAHE8v/3r/9//zIA1f36/R+o4tevf1ANYNVA9P07RD9IJQMDQACxADHD3z8Ig4GMHz+AqqHagKp//fwLVA0U//v7LwMDQACx/LZiYFD7/5/53/+///79BqK/EMZ/UPACSYa/v/8DyX9A0oTxx2EGgABi+a/H8F/m339BoCoQ+g8kgRaCQvgPJJiBYmAuw39hxn+uDAABxMLwi+E/0PusRkwMvxhBGoDkH4b/v/+D2EDyz///QB1/QLb8+sP0lQEggFh+vGXYM2/SP6A2Zoaf30Ex/J+PgekHwz9gQDAz/P0FYrAyMfz7wcDAzPDtFwNAgAEAd3SIyRitX1gAAAAASUVORK5CYII=' alt='Germany - Bundesliga' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Germany - Bundesliga'><br><font style='font-size:11px;color:#222222;'>DE</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Germany - 2. Bundesliga'><a href='latest.asp?league=germany2' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGzSURBVHjaYvTxcWb4+53h3z8GZpZff/79+v3n/7/fDAz/GHAAgABi+f37e3FxOZD1Dwz+/v3z9y+E/AMFv3//+Qumfv9et241QACxMDExAVWfOHkJJAEW/gUEP0EQDn78+AHE/gFOQJUAAcQiy8Ag8O+fLFj1n1+/QDp+/gQioK7fP378+vkDqOH39x9A/RJ/gE5lAAhAYhzcAACCQBDkgRXRjP034R0IaDTZTFZn0DItot37S94KLOINerEcI7aKHAHE8v/3r/9//zIA1f36/R+o4tevf1ANYNVA9P07RD9IJQMDQACxADHD3z8Ig4GMHz+AqqHagKp//fwLVA0U//v7LwMDQACx/LZiYFD7/5/53/+///79BqK/EMZ/UPACSYa/v/8DyX9A0oTxx2EGgABi+a/H8F/m339BoCoQ+g8kgRaCQvgPJJiBYmAuw39hxn+uDAABxMLwi+E/0PusRkwMvxhBGoDkH4b/v/+D2EDyz///QB1/QLb8+sP0lQEggFh+vGXYM2/SP6A2Zoaf30Ex/J+PgekHwz9gQDAz/P0FYrAyMfz7wcDAzPDtFwNAgAEAd3SIyRitX1gAAAAASUVORK5CYII=' alt='Germany - 2. Bundesliga' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Germany - 2. Bundesliga'><br><font style='font-size:11px;color:#222222;'>D2</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Denmark'><a href='latest.asp?league=denmark' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGBSURBVHjaYvzIwPCPAQqADIG/f/+9evVBUvIfmIuM/oDVAAQQC5DFUV0NVv4PiBgZGZl4eblLiv99/fb/z5//v38zgEkg+9/v3y83bQIIIBawtv//njxl+Pv3PxABwd+/f+8//PflM0jdr9//f//6/+sXUDWTrCzQdIAALM1BDgBADAFA/f+PSahm9+YwuAc4X3ev7cSiHz0ts0EjEVgBOBpzGwAAEAQS99/WDkgU7e95IWi+NuQ7VE03KHz7KiRykwKvAGIE2g90938wgBj//x/QRob/GICRienjhw8AAcTCAJdjAEOwvv/YACPIqH8AAcTyipmZNyvr7/37IFf9+sW1a9f/jx+/+Pr9+/wJ4h6IB4CyLEpKT86dAwggsA2QgAO6FUhCLPv1k+HnT6ggUMMfYOD+BXoV6AeAAAJ5+v/vP0ySkmBj/oICmZkZGIIMX74wQoL/zx+mv2DVf0GyAAHE+BQchZCIBCKxt2//PHr0xtAQLghJB5BoZmJgAAgwAAauWfWiVmegAAAAAElFTkSuQmCC' alt='Denmark' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Denmark'><br><font style='font-size:11px;color:#222222;'>DK</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='England - Premier League'><a href='latest.asp?league=england' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGCSURBVHjaYvz48SMDEvj3j+Hfty/npKX/MTAY3L7NwMf3DxUABBALUBEfHx+Q/P//P1QPJ7t6UdG/P3+EpKQY2Nj+I4Fnz54BBBALRBFcNUj4378fDx78+/3739+/QBvhqhkZGf/8+QMQQCxoqiEkUPX/X7+BShiQjAc7+B9AALE8SEmRi4//++ED0Dyg2Qx///77+fPfr1//f/9+PWMGUBVQHCT15w+LkNCF3FyAAGJ5t3q1oJLSr8eP///+8//Pb5BLgMYDyV+/3q1Z8w/MAPrn/69f7AoKzxgYAAKIhcventvIiE1e/t+/vwx/QIYBbfi4dStQKa+LC9QGoIa/f1lFRAT27QMIIMa3b9/y8/PDXQ/ywI8ft1xdgQar7tsHDyWgLNDTd+7cAQggFqA/kL0LkQQ5A4j+/mVE8jEQAEMJIIBAGuCqIaKMDAxsMjJAJzEyMQFNhYlBZQECCKTh1atXyHH56927Q1u2/GJgcLh0iUFICOSEf//+gB0CBAABBgAC4UQezUonUAAAAABJRU5ErkJggg==' alt='England - Premier League' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='England - Premier League'><br><font style='font-size:11px;color:#222222;'>EN</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='England - Championship'><a href='latest.asp?league=england2' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGCSURBVHjaYvz48SMDEvj3j+Hfty/npKX/MTAY3L7NwMf3DxUABBALUBEfHx+Q/P//P1QPJ7t6UdG/P3+EpKQY2Nj+I4Fnz54BBBALRBFcNUj4378fDx78+/3739+/QBvhqhkZGf/8+QMQQCxoqiEkUPX/X7+BShiQjAc7+B9AALE8SEmRi4//++ED0Dyg2Qx///77+fPfr1//f/9+PWMGUBVQHCT15w+LkNCF3FyAAGJ5t3q1oJLSr8eP///+8//Pb5BLgMYDyV+/3q1Z8w/MAPrn/69f7AoKzxgYAAKIhcventvIiE1e/t+/vwx/QIYBbfi4dStQKa+LC9QGoIa/f1lFRAT27QMIIMa3b9/y8/PDXQ/ywI8ft1xdgQar7tsHDyWgLNDTd+7cAQggFqA/kL0LkQQ5A4j+/mVE8jEQAEMJIIBAGuCqIaKMDAxsMjJAJzEyMQFNhYlBZQECCKTh1atXyHH56927Q1u2/GJgcLh0iUFICOSEf//+gB0CBAABBgAC4UQezUonUAAAAABJRU5ErkJggg==' alt='England - Championship' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='England - Championship'><br><font style='font-size:11px;color:#222222;'>E2</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='England - League One'><a href='latest.asp?league=england3' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGCSURBVHjaYvz48SMDEvj3j+Hfty/npKX/MTAY3L7NwMf3DxUABBALUBEfHx+Q/P//P1QPJ7t6UdG/P3+EpKQY2Nj+I4Fnz54BBBALRBFcNUj4378fDx78+/3739+/QBvhqhkZGf/8+QMQQCxoqiEkUPX/X7+BShiQjAc7+B9AALE8SEmRi4//++ED0Dyg2Qx///77+fPfr1//f/9+PWMGUBVQHCT15w+LkNCF3FyAAGJ5t3q1oJLSr8eP///+8//Pb5BLgMYDyV+/3q1Z8w/MAPrn/69f7AoKzxgYAAKIhcventvIiE1e/t+/vwx/QIYBbfi4dStQKa+LC9QGoIa/f1lFRAT27QMIIMa3b9/y8/PDXQ/ywI8ft1xdgQar7tsHDyWgLNDTd+7cAQggFqA/kL0LkQQ5A4j+/mVE8jEQAEMJIIBAGuCqIaKMDAxsMjJAJzEyMQFNhYlBZQECCKTh1atXyHH56927Q1u2/GJgcLh0iUFICOSEf//+gB0CBAABBgAC4UQezUonUAAAAABJRU5ErkJggg==' alt='England - League One' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='England - League One'><br><font style='font-size:11px;color:#222222;'>E3</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='England - League Two'><a href='latest.asp?league=england4' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGCSURBVHjaYvz48SMDEvj3j+Hfty/npKX/MTAY3L7NwMf3DxUABBALUBEfHx+Q/P//P1QPJ7t6UdG/P3+EpKQY2Nj+I4Fnz54BBBALRBFcNUj4378fDx78+/3739+/QBvhqhkZGf/8+QMQQCxoqiEkUPX/X7+BShiQjAc7+B9AALE8SEmRi4//++ED0Dyg2Qx///77+fPfr1//f/9+PWMGUBVQHCT15w+LkNCF3FyAAGJ5t3q1oJLSr8eP///+8//Pb5BLgMYDyV+/3q1Z8w/MAPrn/69f7AoKzxgYAAKIhcventvIiE1e/t+/vwx/QIYBbfi4dStQKa+LC9QGoIa/f1lFRAT27QMIIMa3b9/y8/PDXQ/ywI8ft1xdgQar7tsHDyWgLNDTd+7cAQggFqA/kL0LkQQ5A4j+/mVE8jEQAEMJIIBAGuCqIaKMDAxsMjJAJzEyMQFNhYlBZQECCKTh1atXyHH56927Q1u2/GJgcLh0iUFICOSEf//+gB0CBAABBgAC4UQezUonUAAAAABJRU5ErkJggg==' alt='England - League Two' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='England - League Two'><br><font style='font-size:11px;color:#222222;'>E4</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='England - National league'><a href='latest.asp?league=england5' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGCSURBVHjaYvz48SMDEvj3j+Hfty/npKX/MTAY3L7NwMf3DxUABBALUBEfHx+Q/P//P1QPJ7t6UdG/P3+EpKQY2Nj+I4Fnz54BBBALRBFcNUj4378fDx78+/3739+/QBvhqhkZGf/8+QMQQCxoqiEkUPX/X7+BShiQjAc7+B9AALE8SEmRi4//++ED0Dyg2Qx///77+fPfr1//f/9+PWMGUBVQHCT15w+LkNCF3FyAAGJ5t3q1oJLSr8eP///+8//Pb5BLgMYDyV+/3q1Z8w/MAPrn/69f7AoKzxgYAAKIhcventvIiE1e/t+/vwx/QIYBbfi4dStQKa+LC9QGoIa/f1lFRAT27QMIIMa3b9/y8/PDXQ/ywI8ft1xdgQar7tsHDyWgLNDTd+7cAQggFqA/kL0LkQQ5A4j+/mVE8jEQAEMJIIBAGuCqIaKMDAxsMjJAJzEyMQFNhYlBZQECCKTh1atXyHH56927Q1u2/GJgcLh0iUFICOSEf//+gB0CBAABBgAC4UQezUonUAAAAABJRU5ErkJggg==' alt='England - National league' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='England - National league'><br><font style='font-size:11px;color:#222222;'>E5</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Spain - La Liga'><a href='latest.asp?league=spain' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAFnSURBVHjaYvzPgAD/UNlYEUAAmuTYAAAQhAEYqF/zFbe50RZ1cMmS9TLi0pJLRjZohAMTGFUN9HdnHgEE1sDw//+Tp0ClINW/f0NIKPoFJH/9//ULyGaUlQXaABBALAx/Gf4zAt31F4i+ffj3/cN/XrFfzOx//v///f//LzACM/79ZmD8/e8TA0AAMYHdDVT958vXP38nMDB0s3x94/Tj5y+YahhiAKLfQKUAAcQEdtJfoDHMF2L+vPzDmFXLelf551tGFOOhev4A/QgQQExgHwAd8IdFT/Wz6j+GhlpmXSOW/2z///8Eq/sJ18Dw/zdQA0AAMQExxJjjdy9x2/76EfLz4MXdP/i+wsyGkkA3Aw3984cBIIAYfzIwMKel/bt3jwEaLNAwgZIQxp/fDH/+MqqovL14ESCAWICeZvr9h0FSEhSgwBgAygFDEMT+wwAhgQgc4kAEVAwQQIxfUSMSTxxDAECAAQAJWke8v4u1tAAAAABJRU5ErkJggg==' alt='Spain - La Liga' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Spain - La Liga'><br><font style='font-size:11px;color:#222222;'>ES</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Spain - La Liga 2'><a href='latest.asp?league=spain2' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAFnSURBVHjaYvzPgAD/UNlYEUAAmuTYAAAQhAEYqF/zFbe50RZ1cMmS9TLi0pJLRjZohAMTGFUN9HdnHgEE1sDw//+Tp0ClINW/f0NIKPoFJH/9//ULyGaUlQXaABBALAx/Gf4zAt31F4i+ffj3/cN/XrFfzOx//v///f//LzACM/79ZmD8/e8TA0AAMYHdDVT958vXP38nMDB0s3x94/Tj5y+YahhiAKLfQKUAAcQEdtJfoDHMF2L+vPzDmFXLelf551tGFOOhev4A/QgQQExgHwAd8IdFT/Wz6j+GhlpmXSOW/2z///8Eq/sJ18Dw/zdQA0AAMQExxJjjdy9x2/76EfLz4MXdP/i+wsyGkkA3Aw3984cBIIAYfzIwMKel/bt3jwEaLNAwgZIQxp/fDH/+MqqovL14ESCAWICeZvr9h0FSEhSgwBgAygFDEMT+wwAhgQgc4kAEVAwQQIxfUSMSTxxDAECAAQAJWke8v4u1tAAAAABJRU5ErkJggg==' alt='Spain - La Liga 2' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Spain - La Liga 2'><br><font style='font-size:11px;color:#222222;'>E2</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Finland'><a href='latest.asp?league=finland' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAF7SURBVHjaYnz6+jMDFDBJu5xg+PWPgYfp6jIDLg6GP/8YGP5BwR8w+eHTF4AAYmFiYJAQ4QEq////f2uZxr////7+ZdBQEgByIYLI4NqdXwABxPIPbDhE+tmbn0BT//799x8bYGRk/PXnH0AAsfwDqvgHNez3XyD7358//4Ek0ARk1Qz//zGANQAEECOD8cH2EpWnb34BDf71+/+fv0BtQHf9+/XnP1Dnb5Ag0Ih/v/7+kxFhX9WwGyAABXRsAwAIw0CQgv3nDbwV+DSuzpLlvSr2Dk5XN5lUYFOXDqPh3TmhvgBiYfj3B2QlyFCwarAiIADqB9r57y8Q/gNjkAJgqAEEEOPt++/lZHj/gR0d13EXaCoQra1X+Yfqc6AngZ4+fv4BQACxMLH8Y2YEcoACDBDVQARWgYZAAOg1gAACOukfPMjFBVnBHgAZxoACGOF6AAKIBejoOw/eQCJyVvFRBoZfwCiPtPzPwwWM6X9A/Ace2/8YPn35AhBgAOvHaZyBALjqAAAAAElFTkSuQmCC' alt='Finland' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Finland'><br><font style='font-size:11px;color:#222222;'>FI</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='France - Ligue 1'><a href='latest.asp?league=france' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGzSURBVHjaYiyeepkBBv79+Zfnx/f379+fP38CyT9//jAyMiq5GP77wvDnJ8MfoAIGBoAAYgGqC7STApL///3/9++/pCTv////Qdz/QO4/IMna0vf/z+9/v379//37bUUTQACBNDD8Z/j87fffvyAVX79+/Q8GQDbQeKA9fM+e/Pv18/+vnwzCIkBLAAKQOAY5AIAwCEv4/4PddNUm3ji0QJyxW3rgzE0iLfqDGr2oYuu0l54AYvnz5x9Q6d+/QPQfyAQqAin9B3EOyG1A1UDj//36zfjr1y8GBoAAFI9BDgAwCMIw+P8Ho3GDO6XQ0l4MN8b2kUwYaLszqgKM/KHcDXwBxAJUD3TJ779A8h9Q5D8SAHoARP36+Rfo41+/mcA2AAQQy49ff0Cu//MPpAeI/0FdA1QNYYNVA/3wmwEYVgwMAAHE8uPHH5BqoD1//gJJLADoJKDS378Z//wFhhJAALF8A3rizz8uTmYg788fJkj4QOKREQyYxSWBhjEC/fcXZANAALF8+/anbcHlHz9+ffvx58uPX9KckkCn/gby/wLd8uvHjx96k+cD1UGiGQgAAgwA7q17ZpsMdUQAAAAASUVORK5CYII=' alt='France - Ligue 1' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='France - Ligue 1'><br><font style='font-size:11px;color:#222222;'>FR</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='France - Ligue 2'><a href='latest.asp?league=france2' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGzSURBVHjaYiyeepkBBv79+Zfnx/f379+fP38CyT9//jAyMiq5GP77wvDnJ8MfoAIGBoAAYgGqC7STApL///3/9++/pCTv////Qdz/QO4/IMna0vf/z+9/v379//37bUUTQACBNDD8Z/j87fffvyAVX79+/Q8GQDbQeKA9fM+e/Pv18/+vnwzCIkBLAAKQOAY5AIAwCEv4/4PddNUm3ji0QJyxW3rgzE0iLfqDGr2oYuu0l54AYvnz5x9Q6d+/QPQfyAQqAin9B3EOyG1A1UDj//36zfjr1y8GBoAAFI9BDgAwCMIw+P8Ho3GDO6XQ0l4MN8b2kUwYaLszqgKM/KHcDXwBxAJUD3TJ779A8h9Q5D8SAHoARP36+Rfo41+/mcA2AAQQy49ff0Cu//MPpAeI/0FdA1QNYYNVA/3wmwEYVgwMAAHE8uPHH5BqoD1//gJJLADoJKDS378Z//wFhhJAALF8A3rizz8uTmYg788fJkj4QOKREQyYxSWBhjEC/fcXZANAALF8+/anbcHlHz9+ffvx58uPX9KckkCn/gby/wLd8uvHjx96k+cD1UGiGQgAAgwA7q17ZpsMdUQAAAAASUVORK5CYII=' alt='France - Ligue 2' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='France - Ligue 2'><br><font style='font-size:11px;color:#222222;'>F2</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Greece'><a href='latest.asp?league=greece' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAF5SURBVHjaYuS1P8rAwHBimgCQNMl4x/CP8fuvvwy//oHRHyj5A4jAIv//AAQQC1Cdk4mAlpbW////XUyvM/z/v6ZT4/9/hv9ACRAFwSDw7z/Dg0fPAAKI8dGjR7KysiBxMAAyjp5/D5T7B1TxD6zuH5TNycF0eNcTgABigSiCqwaSF25///vv35+////+BZF//vz/A+T//S8kwFI/5QpAADGyWx92Mxfa2KMJVO2UdQVo0rYJWlBXMECdArGJiYnp1q1HAAHE8ucXzI0QN/z775Zz5R/EJf/+QxFI+D8PJ8uFQ3cBAojxxYs3IiICSAYiM/7BMdC9QBvu3XsIEEAs6w99sdBl/vbz33+YSf8hZsMcA1QMYXBxMB/Z9QUggFgOnnmhJMP74cuvv0Bf/gN5FM74B+ECPfwPJCLEy9q56SZAADHevP9RVIgd5A5I8IGdwwD1KMKFDCC/MJw6ewsggBgZxDdDI/LnPwaGPxjoHxj9AQc7iAQIMADrG2tQp2zGfgAAAABJRU5ErkJggg==' alt='Greece' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Greece'><br><font style='font-size:11px;color:#222222;'>GR</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='SouthKorea'><a href='latest.asp?league=southkorea' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAHiSURBVHjaYvz4/SsDEvj37x+YhLCgGAb+ADFAADEBpfk4uIDo2YNHV89fZP3PyMfBLcDFxc/NLcjNy8nMfPnM2cd374ry84sJCAE1AAQQC8Tg169fb9269cP7DyJiYsqKiv/v3v3/589/FZVnL16uXbtGQFBQWEhIRlYWaAVAAIFs+P///4cPH37//m1oYqwsJfm/t/d/QcH/vJz/ddUKYqJuXl5v3rx5/uIFUBnQBoAAYgT6gZedE6jt1atXXLy8jHsOcEyd+P/37y9/mH7+/CWQEPEpIvLj6zdS0lKMjIwPnj0BCCAWiC+BukVERICMnW/4jP8w/2bibDLMf/aTvfrxOX12dm5pKaACBkZGoJMAAgioAaQaCN6+fcvDzfVVXTdXvZKZjfURu9iHHz/vGrupf//85u1HSUlJRqCef/8AAogJiIGqb968OW3aNKC/PQw4VS1UnjALMXz/4azD5uokvW/f/vr6+pMnT0L8ABBALP/AocTFxQXkHzx0WFNLszZM7ZIJ+5+//3UV2O/du7l6zXphYWEBAQGgAqCTAAII5AcgS1pa2t3d/eXLl2JikkD9ekpcEHeKi0t5eHgANairq4PjlQEggBifv32LHJFwiuEPmMEAYf/5A1YNxAABBgCFMRk3L8TWJAAAAABJRU5ErkJggg==' alt='SouthKorea' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='SouthKorea'><br><font style='font-size:11px;color:#222222;'>KR</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Netherlands - Eredivisie'><a href='latest.asp?league=netherlands' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAFXSURBVHjaYvzPgAD/UNlYEUAAkuTgCAAIBgJggq5VoAs1qM0vdzmMz362vezjokxPGimkEQ5WoAQEKuK71zwCCKyB4c//J8+BShn+/vv/+w/D399AEox+//8FJH/9/wUU+cUoKw20ASCAWBhEDf/LyDOw84BU//kDtgGI/oARmAHRDJQSFwVqAAggxo8fP/Ly8oKc9P8/AxjiAoyMjA8ePAAIIJZ///5BVIM0MOBWDpRlZPzz5w9AALH8gyvCbz7QBrCJAAHEyKDYX15r/+j1199//v35++/Xn7+///77DST/wMl/f4Dk378K4jx7O2cABBALw7NP77/+ev3xB0gOpOHfr99AdX9/gTVASKCGP//+8XCyMjC8AwggFoZfIHWSwpwQk4CW/AYjsKlA8u+ff////v33998/YPgBnQQQQIzAaGNg+AVGf5AYf5BE/oCjGEIyAQQYAGvKZ4C6+xXRAAAAAElFTkSuQmCC' alt='Netherlands - Eredivisie' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Netherlands - Eredivisie'><br><font style='font-size:11px;color:#222222;'>NL</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Netherlands - Eerste Divisie'><a href='latest.asp?league=netherlands2' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAFXSURBVHjaYvzPgAD/UNlYEUAAkuTgCAAIBgJggq5VoAs1qM0vdzmMz362vezjokxPGimkEQ5WoAQEKuK71zwCCKyB4c//J8+BShn+/vv/+w/D399AEox+//8FJH/9/wUU+cUoKw20ASCAWBhEDf/LyDOw84BU//kDtgGI/oARmAHRDJQSFwVqAAggxo8fP/Ly8oKc9P8/AxjiAoyMjA8ePAAIIJZ///5BVIM0MOBWDpRlZPzz5w9AALH8gyvCbz7QBrCJAAHEyKDYX15r/+j1199//v35++/Xn7+///77DST/wMl/f4Dk378K4jx7O2cABBALw7NP77/+ev3xB0gOpOHfr99AdX9/gTVASKCGP//+8XCyMjC8AwggFoZfIHWSwpwQk4CW/AYjsKlA8u+ff////v33998/YPgBnQQQQIzAaGNg+AVGf5AYf5BE/oCjGEIyAQQYAGvKZ4C6+xXRAAAAAElFTkSuQmCC' alt='Netherlands - Eerste Divisie' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Netherlands - Eerste Divisie'><br><font style='font-size:11px;color:#222222;'>N2</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Italy - Serie A'><a href='latest.asp?league=italy' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAE2SURBVHjaYmSYyMDwgwEE/jEw/GF4mvT0HyqQUlX9B5aEIIAAYmH4wlDtWg1SDwT//0lKSv7/D+T9/w+nYmL+//79/88fIPll0yaAAGJhYAGJP/n69O+/v0CAUAcHt2////ULqJpRVhZoA0AAsQCtAZoMVP0HiP7+RlcNBEDVYA0Mv38DNQAEEMj8vwx//wCt/AdC/zEBkgagYoAAYgF6FGj277+///wlpAEoz8AAEEAgDX/BZv/69wuoB48GRrCTAAKICajh9//fv/6CVP/++wu7BrDxQFf/YWAACCCwk0BKf0MQdg1/gBqAPv0L9ANAALEAY+33vz+S3JIgb/z5C45CBkZGRgY4UFICKQUjoJMAAoiRoZSB4RMojkHx/YPhbNVZoM3AOISQQPUK9vaQOIYAgAADAC5Wd4RRwnKfAAAAAElFTkSuQmCC' alt='Italy - Serie A' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Italy - Serie A'><br><font style='font-size:11px;color:#222222;'>IT</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Italy - Serie B'><a href='latest.asp?league=italy2' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAE2SURBVHjaYmSYyMDwgwEE/jEw/GF4mvT0HyqQUlX9B5aEIIAAYmH4wlDtWg1SDwT//0lKSv7/D+T9/w+nYmL+//79/88fIPll0yaAAGJhYAGJP/n69O+/v0CAUAcHt2////ULqJpRVhZoA0AAsQCtAZoMVP0HiP7+RlcNBEDVYA0Mv38DNQAEEMj8vwx//wCt/AdC/zEBkgagYoAAYgF6FGj277+///wlpAEoz8AAEEAgDX/BZv/69wuoB48GRrCTAAKICajh9//fv/6CVP/++wu7BrDxQFf/YWAACCCwk0BKf0MQdg1/gBqAPv0L9ANAALEAY+33vz+S3JIgb/z5C45CBkZGRgY4UFICKQUjoJMAAoiRoZSB4RMojkHx/YPhbNVZoM3AOISQQPUK9vaQOIYAgAADAC5Wd4RRwnKfAAAAAElFTkSuQmCC' alt='Italy - Serie B' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Italy - Serie B'><br><font style='font-size:11px;color:#222222;'>I2</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Norway'><a href='latest.asp?league=norway' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGSSURBVHjaYnzIAAVy//9zRV36skTnATPzPwaGf2BBCOMPEgkQQCxAUcHaaiD5////ngQpRkZG4aLC/3//MPz58x+Efv//DSL/Acnfv+9u2AQQQCxgg/7/e/IUSL18/weo7c+DB0AVDL+BioCqgejXv1+//v/6zSwrC7QBIIDAGv4CVf0F0f9ADvn/5xfI1F8gpSDVQD2/QCTT799AVwEEEIvM379AZ0Cc9Aeo8/9/gbUb/mMDQGUanz4BBBAjc/D5/mTpF+9///0HdvO/f0BtQA6I/AMk//3+CxIHikgJss7OOQ0QQIx///6FGP+f4X/JgmfdcZL/cQAmJqb3798DBBDLPWZmkdysP/fuC2zY9BvspLd21v9+gXzMAPLub6g3fv9hUVa6evocQACxAL35HxxkQKUgZ/3//+8nRMUvkCBIJ4jxD+iQP8DAZgAIILCGP3+YJEEuEeUDBRqzjCzTX1DAM4CDn/nPH5Dqv3//gR0PEECMV2FRqPD+vaDeibcXzK4JC/+BxTEkghlgJBAABBgA9J5akqVspaUAAAAASUVORK5CYII=' alt='Norway' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Norway'><br><font style='font-size:11px;color:#222222;'>NO</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Norway2'><a href='latest.asp?league=norway2' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGSSURBVHjaYnzIAAVy//9zRV36skTnATPzPwaGf2BBCOMPEgkQQCxAUcHaaiD5////ngQpRkZG4aLC/3//MPz58x+Efv//DSL/Acnfv+9u2AQQQCxgg/7/e/IUSL18/weo7c+DB0AVDL+BioCqgejXv1+//v/6zSwrC7QBIIDAGv4CVf0F0f9ADvn/5xfI1F8gpSDVQD2/QCTT799AVwEEEIvM379AZ0Cc9Aeo8/9/gbUb/mMDQGUanz4BBBAjc/D5/mTpF+9///0HdvO/f0BtQA6I/AMk//3+CxIHikgJss7OOQ0QQIx///6FGP+f4X/JgmfdcZL/cQAmJqb3798DBBDLPWZmkdysP/fuC2zY9BvspLd21v9+gXzMAPLub6g3fv9hUVa6evocQACxAL35HxxkQKUgZ/3//+8nRMUvkCBIJ4jxD+iQP8DAZgAIILCGP3+YJEEuEeUDBRqzjCzTX1DAM4CDn/nPH5Dqv3//gR0PEECMV2FRqPD+vaDeibcXzK4JC/+BxTEkghlgJBAABBgA9J5akqVspaUAAAAASUVORK5CYII=' alt='Norway2' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Norway2'><br><font style='font-size:11px;color:#222222;'>N2</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Poland'><a href='latest.asp?league=poland' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAEISURBVHjaYvz/8SMDDPyD43//gPQ/bAAggFhACvn4gMT///8Zwdr+/wcRjP//MzMwMP1HAV+ePQMIIBYGqKL/yIz/2AAjI+O/P38AAoiFSNUQKaCTAAKIBehWRrhqMMSjAagDIIBYGPj5Gfr6/j979v/PH4Y/f/7D0e/f/38DGb/BjN8gWWnpfwsXAgQQ2EkPH/5/8OD/718MvyHqfv3/9fv/r18gNhLJ+OkT0DkAAQR2ElgIZDyyIlTVEMv/MDAABBBIAzPYAQxwRZja/gA1/GX4+xfoHIAAAmlg+v2HQVISbMxfhj8gnYxgIxkgJBD9/QtBQMUAAcT4FRy5cMSAykWTAgKAAAMA0PVcqMe0XaEAAAAASUVORK5CYII=' alt='Poland' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Poland'><br><font style='font-size:11px;color:#222222;'>PL</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Portugal - Liga Portugal'><a href='latest.asp?league=portugal' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAG8SURBVHjaYmSIZGD4wgAF/xgYWBj+boQysSKAAGJh+MRQnVoNUgEE///9ZfzLoPiX4e8fxj9/mP/8Yfr9+/+fP/9h5JdNmwACiIWBCaj4/5P3T7mY/xoJ/9UR/v0n8O+f17/Zlv/+//73/1+////+9f/XL6BqRllZoA0AAcQCNvv/339/C03+8v/8w7bk7+/vv/+7/P4S95ur+xdY9W+IBobfv4EaAAKICeiuv////vnz58PX3xxb/7BlN3/K7Ph1WoSR/fcfhl//f4KN/wW1BGg6QAAxMfxi+PP37++/v1kYfn//+usnE+cHCbWfTKz/mH7+ZgUpQmj48wdoA0AAsQA1/P0HZP458/qXqvNfjdnVItxy3wNvApUIvwPb8BvqJEawkwACiIXhDwPQ+F9/f+2890dY6/cnrycCb++z3frNfOwX01eEagZgKAHdzcAAEEAgG4DGA/W8+fO79+Rvdt5f2+b++sP+m+kdWDVEwx+gBmBY/wX6ASCAWBi+Mfz+80eSX/L3n99AzwBDm0H2NwtQHS/QapDBIPT3LwQBnQQQQIwMxgwM7xgYfjAArQKRTAyvP2OPYwgACDAAjtdGduN8tIgAAAAASUVORK5CYII=' alt='Portugal - Liga Portugal' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Portugal - Liga Portugal'><br><font style='font-size:11px;color:#222222;'>PT</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Portugal - Liga Portugal 2'><a href='latest.asp?league=portugal2' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAG8SURBVHjaYmSIZGD4wgAF/xgYWBj+boQysSKAAGJh+MRQnVoNUgEE///9ZfzLoPiX4e8fxj9/mP/8Yfr9+/+fP/9h5JdNmwACiIWBCaj4/5P3T7mY/xoJ/9UR/v0n8O+f17/Zlv/+//73/1+////+9f/XL6BqRllZoA0AAcQCNvv/339/C03+8v/8w7bk7+/vv/+7/P4S95ur+xdY9W+IBobfv4EaAAKICeiuv////vnz58PX3xxb/7BlN3/K7Ph1WoSR/fcfhl//f4KN/wW1BGg6QAAxMfxi+PP37++/v1kYfn//+usnE+cHCbWfTKz/mH7+ZgUpQmj48wdoA0AAsQA1/P0HZP458/qXqvNfjdnVItxy3wNvApUIvwPb8BvqJEawkwACiIXhDwPQ+F9/f+2890dY6/cnrycCb++z3frNfOwX01eEagZgKAHdzcAAEEAgG4DGA/W8+fO79+Rvdt5f2+b++sP+m+kdWDVEwx+gBmBY/wX6ASCAWBi+Mfz+80eSX/L3n99AzwBDm0H2NwtQHS/QapDBIPT3LwQBnQQQQIwMxgwM7xgYfjAArQKRTAyvP2OPYwgACDAAjtdGduN8tIgAAAAASUVORK5CYII=' alt='Portugal - Liga Portugal 2' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Portugal - Liga Portugal 2'><br><font style='font-size:11px;color:#222222;'>P2</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Russia'><a href='latest.asp?league=russia' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAE2SURBVHjaYvz69T8DAvz79w9CQVj/0MCffwwAAcQClObiAin6/x+okxHMgPCAbOb//5n+I4EXL74ABBALxGSwagTjPzbAyMgItAQggBg9Pf9nZPx//x7kjL9////9C2QAyf9//qCQQCQkxFhY+BEggFi2b/+nq8v46BEDSPQ3w+8//3//BqFfv9BJeXmQEwACCOSkP38YgHy4Bog0RN0vIOMXVOTPH6Cv/gEEEEgDxFKgHEgDXCmGDUAE1AAQQCybGZg1f/d8//XsH0jTn3+///z79RtE/v4NZfz68xfI/vOX+4/0ZoZFAAHE4gYMvD+3/v2+h91wCANo9Z+/jH9VxBkYAAKIBRg9TL//MEhKAuWAogxgZzGC2CCfgUggAoYdGAEVAwQQ41egu5AQAyoXTQoIAAIMAD+JZR7YOGEWAAAAAElFTkSuQmCC' alt='Russia' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Russia'><br><font style='font-size:11px;color:#222222;'>RU</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Scotland - Premiership'><a href='latest.asp?league=scotland' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAIbSURBVHjaYnz06BEDA0Pmzu9bp1xikOJgEOFi+PGH4c8/hl9g8h8Dw713DHc/ydYaHUiQ+vr9O0AAMdbufNzkJgPU8+3P36atj/++/fFHkO0vA0jxHyB4/v23ANukMEUuZsb///+7TTsHEEDMhy5bCOsImcnysDIxuqgLPPnz7/TxF29//Xv74cebOx9sbSSaPWVYGBmAqgs3PVyXthIggJgZPLINRDgXHnymIc8jws1iIMXtbCK65uDz39/+LinVs1PkBSo99+SLZ8u5f9/+3jv7BSCAWIB2/+Vn/fP9d/2cG/qWYpUOUoIczJvL9f/DQOHmh3u3PfwtzvFbmI3hxzeAAGICu/T/b1am39JcJ9bf8+q79B8JGDee2bvoxi8F3l9szH9+/2P4/QcggJhANjD8//P1z6/7n9TdZLcU6CBrOF1rZBCk9Ov6u1+ff/8GBdkfgAACOen3ux+/3n6rTtAwk+UCKvr8669z89nff/7tqzPiYWGcF6q4R18osfvcX1ZgWDIBBBATw7EX/KKcG8sNIKpnHH/hVH7iFxPjT2ZGs9wjPYeeAgWdVHgfzrQXkeMBRgpAADGGzr+8LEYDKPrr3/+EZXf+PP78W5TzN+P/P3///f7178+jz3+kuLana7IxAo1n4MvfDRBAjMCY/vfvn+vix7drjzCwcjBI8TB8+QGKZhD6B1L1/w0DwweGUIcr9fpAHkCAAQAGHylL06NptQAAAABJRU5ErkJggg==' alt='Scotland - Premiership' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Scotland - Premiership'><br><font style='font-size:11px;color:#222222;'>SC</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Scotland - Championship'><a href='latest.asp?league=scotland2' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAIbSURBVHjaYnz06BEDA0Pmzu9bp1xikOJgEOFi+PGH4c8/hl9g8h8Dw713DHc/ydYaHUiQ+vr9O0AAMdbufNzkJgPU8+3P36atj/++/fFHkO0vA0jxHyB4/v23ANukMEUuZsb///+7TTsHEEDMhy5bCOsImcnysDIxuqgLPPnz7/TxF29//Xv74cebOx9sbSSaPWVYGBmAqgs3PVyXthIggJgZPLINRDgXHnymIc8jws1iIMXtbCK65uDz39/+LinVs1PkBSo99+SLZ8u5f9/+3jv7BSCAWIB2/+Vn/fP9d/2cG/qWYpUOUoIczJvL9f/DQOHmh3u3PfwtzvFbmI3hxzeAAGICu/T/b1am39JcJ9bf8+q79B8JGDee2bvoxi8F3l9szH9+/2P4/QcggJhANjD8//P1z6/7n9TdZLcU6CBrOF1rZBCk9Ov6u1+ff/8GBdkfgAACOen3ux+/3n6rTtAwk+UCKvr8669z89nff/7tqzPiYWGcF6q4R18osfvcX1ZgWDIBBBATw7EX/KKcG8sNIKpnHH/hVH7iFxPjT2ZGs9wjPYeeAgWdVHgfzrQXkeMBRgpAADGGzr+8LEYDKPrr3/+EZXf+PP78W5TzN+P/P3///f7178+jz3+kuLana7IxAo1n4MvfDRBAjMCY/vfvn+vix7drjzCwcjBI8TB8+QGKZhD6B1L1/w0DwweGUIcr9fpAHkCAAQAGHylL06NptQAAAABJRU5ErkJggg==' alt='Scotland - Championship' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Scotland - Championship'><br><font style='font-size:11px;color:#222222;'>S2</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Sweden'><a href='latest.asp?league=sweden' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGwSURBVHjaYmRwbmSAgb919Qz/GICIuayU4dc/hl+/GH79YfjxC8H4/QsggFiA6qpzPYHkv3//GZW/Mfz7+5/hb26J35+////8/QdEv//+BZH/QIxNuZMBAogFbPT/J++//f33n+Hno///fzP8/3v/9effQEV//gIV/frz9xeQ/fuvrDA3A8MvgABiAZr87x8DUPWfn6wQ1f///WJh/PHtD9MvsJ5fYPT7H1Az0Lm/AAKI8e9BBkalMoZfQLP/MPz/8//fbxD6Dyb//QIjMOP/b0Z2+U97DwIEEAvDHwaQqSAVMA3/f0G1IVSDGAz//gCVAAQQ0EkM/0Hq/gBFgUJIGpBIsAgj0Od/GAACiJFBvzirLOD+m4/AoNjq3gu26pf52pLff/6A/PCD6dcfYPj8+/Pnr7IY39nWSQABxMLw488fkIf+/v7zD2bYr19A1aAg+gcM/98Mf/8w/vvDBETsDAxPAAKIBRgpQKWS/NzAAGFgk2YABtS/37JCPKCwB7r531+gOX///gOhf6BIBQggRgbJZHhEvp2zFhgGQIeKptsygELjFwz9A3OBJANAgAEA3Ll5iCfmAhAAAAAASUVORK5CYII=' alt='Sweden' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Sweden'><br><font style='font-size:11px;color:#222222;'>SE</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Turkey'><a href='latest.asp?league=turkey' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAF+SURBVHjaYvzPgAD/UNlYEUAAmuTYBgAYhIEgJJmboZgtHbaJKNK8TvozM8LIllwagEY4sIFV1UD/3swngMAaGBn/P3kCVApS7ebG8O/f/x07/n/6BFL36/f/37/+//oFZDPKygJtAAggkIb/YINBqqOjGUxNQeqUlf93dIDV/QLpAWtg+P0bqAEggJhA7gaqBtqoqMjg5PR/+vT/SUn/N2z4//Xr/+XL//Pwgu2BWgJUCxBATCAn/fgJEnVx/Q+05NgxkNzp0/9XrPgvJPR/zZr/ZmZQDX/+AE0HCCCQhv9//4D89OQxMMT+a2uDnKGm9v/SJZCrHj36v28fRAPESQABxALEjGBLGRYv/s/H97+oCOQYIIiM/P/ly/9Fi6CO+QMy9A8DA0AAgTQwg4MMaMD/rq7/vr7/WVlBrv/8GeROiAf+ADWAQgXoHIAAAmlg+v+fQVISbMxfhpMngToZhYUZ+PkZwAaDEDgMgQioGCCAGL+iRiSeOIYAgAADAO/XO1xGA79vAAAAAElFTkSuQmCC' alt='Turkey' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Turkey'><br><font style='font-size:11px;color:#222222;'>TR</font></span></a></td><td align='center' valign='middle' style='background-color:#ffffff;line-height:14px;'><span title='Ukraine'><a href='latest.asp?league=ukraine' style='display:block; text-decoration:none;' class='horiz'><img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAFQSURBVHjaYmRo/c8AB//+MfwBkgwg8s8/KPoFI4GIgQEgAIdycgMACAMxUAF6oygqoQ1q45dkzSH5N26XR/8zCEuepggsVEPFkxB+S9bcRwCxMDCBVD/5+h+o9O8/BqDE378Mv/+DpCGKfgERmCHLw8jw4x9AAIFs+AdUBLQWZDZI9a/////8BSuFawBzf/8FuQMggFiALvsLsh2k+g/cbCTVUBLkKgaGDwwAAcTCIHJKhFPh19+fIHf/+/cbpBNI/gO75x+I/RfKluFiY5A6AhBAjH8fMjDI5P///+A/wy8GoFf/A+34hZVkYlJ6f/wUQACxAEOSESwEDEhURSiqwbJ/gKENEEAgDcwgDlAIrgiLNgaGvyD0hwEggEAamP4DdUrCREE6GRl/gyMPQv6BqgYG+z8GgABi/HoTFL///kBJBjgbwmBAcEEcBgaAAAMASIdu6OFHDhsAAAAASUVORK5CYII=' alt='Ukraine' width='14' height='11' style='margin-top:4px;margin-bottom:1px;' alt='Ukraine'><br><font style='font-size:11px;color:#222222;'>UA</font></span></a></td>





<td align='center' valign='middle' style='background-color:#ffffff;' width='4'></td>


</tr>





</table>




				
	 		</div>
	









	

	 

	 <div style="background-color:#ffffff;text-align:left;max-width:990px;border-bottom:1px solid #bbbbbb;border-left:0px solid #666666;border-right: 0px solid #666666;padding-top:3px;padding-bottom:0px;">
        <iframe title="In-play matches" loading="lazy" bgcolor="#ffffff" frameborder="0" src="fr/team_live.asp" id="PPG" width="100%" height="24" style="overflow:hidden;padding-top:2px;" scrolling="no"></iframe>
	 </div>                    
        

	<table cellspacing='3' cellpadding='0' bgcolor='#ffffff' width='100%' style='border-bottom:1px solid #aaaaaa;'>
	<tr height='38'>            

    <td align='center' valign='middle' style='background-color:#ffffff;' width='10'></td>


	<td align='center' valign='middle'>     


	</td>


	<td align='center' valign='middle' style='background-color:#ffffff;' width='5'></td>

    <td align='center' valign='middle' style='background-color:#ffffff;' width='10'></td>


	
	<td align='center' valign='middle' width='180'>



	
		<div class="form-leaguesearch" style='background-color:#ffffff;margin-top:0px;border: 1px solid #cccccc;'>
			<input type="text" name="theleague" id="autocomplete" max-length="20" value="Search league..." onfocus="if (this.value == 'Search league...') {this.value = '';}" onblur="if (this.value == '') {this.value = 'Search league...';}" style="border:none;width:180px;height:18px;padding-left:5px;padding-top:2px;font-size:13px;color:#111111;background-color:#ffffff;" />
		</div>

	</td>	

	<td align='center' valign='middle' style='background-color:#ffffff;' width='10'></td>

	<td align='center' valign='middle' width='180'>


		<div class="form-teamsearch" style='background-color:#ffffff;margin-top:0px;border:1px solid #cccccc;'>
			<input type="text" name="theteam" id="autocomplete2" value="Search team..." onfocus="if (this.value == 'Search team...') {this.value = '';}" onblur="if (this.value == '') {this.value = 'Search team...';}" style="border:none;width:180px;height:18px;padding-left:5px;padding-top:2px;font-size:13px;color:#111111;background-color:#ffffff;" />
		</div>

	</td>





	<td align='center' valign='middle' style='background-color:#ffffff;' width='5'></td>

	</tr>
	</table>
		

	
	




	 	</div>					
		
		
		
		
		
		
		
		
		
		
		
		
		
		
	 	
	 	




	 </div>












<!-- Close Headerlocal div --> 
</div>




















		
		<div id="content" style="width:990px;min-height:1400px;background-color:#ffffff;padding-top:2px;text-align:left;border:0px solid #cccccc;">	

<!-- League navigation -->
<div style="height:40px;background-color:#f0f0f0;margin-top:20px;text-align:left;">

		<div style="width:30px;background-color:#f0f0f0;margin-top:11px;padding-left:12px;text-align:left;float:left;">
		<!-- Flag -->
      
		<img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGCSURBVHjaYvz48SMDEvj3j+Hfty/npKX/MTAY3L7NwMf3DxUABBALUBEfHx+Q/P//P1QPJ7t6UdG/P3+EpKQY2Nj+I4Fnz54BBBALRBFcNUj4378fDx78+/3739+/QBvhqhkZGf/8+QMQQCxoqiEkUPX/X7+BShiQjAc7+B9AALE8SEmRi4//++ED0Dyg2Qx///77+fPfr1//f/9+PWMGUBVQHCT15w+LkNCF3FyAAGJ5t3q1oJLSr8eP///+8//Pb5BLgMYDyV+/3q1Z8w/MAPrn/69f7AoKzxgYAAKIhcventvIiE1e/t+/vwx/QIYBbfi4dStQKa+LC9QGoIa/f1lFRAT27QMIIMa3b9/y8/PDXQ/ywI8ft1xdgQar7tsHDyWgLNDTd+7cAQggFqA/kL0LkQQ5A4j+/mVE8jEQAEMJIIBAGuCqIaKMDAxsMjJAJzEyMQFNhYlBZQECCKTh1atXyHH56927Q1u2/GJgcLh0iUFICOSEf//+gB0CBAABBgAC4UQezUonUAAAAABJRU5ErkJggg==' width='23' height='17' style='padding-top:0px;' alt='england'>		
		</div>


		
		<div style="width:400px;background-color:#f0f0f0;margin-top:12px;padding-right:10px;text-align:left;float:left;">
		<!-- League name -->
<font style='color:#444444;font-size:18px;'>Premier League</font>
		</div>



		<div style="width:120px;background-color:#f0f0f0;margin-top:7px;padding-left:2px;text-align:left;float:left;">
		<!-- Seasons combo -->


        <div class="dropdown" style="float:left;">
        <button class="dropbtn" style='height:26px;font-size:14px;color:#222222;'>2025/26 <font color='#aaaaaa'>&#9660;</font></button>
        <div class="dropdown-content" style="left:0;width:80px;">        
              
                <a href="latest.asp?league=england">2025/26</a>
            
                <a href="latest.asp?league=england_2025">2024/25</a>

                <a href="latest.asp?league=england_2024">2023/24</a>

                <a href="latest.asp?league=england_2023">2022/23</a>

                <a href="latest.asp?league=england_2022">2021/22</a>

                <a href="latest.asp?league=england_2021">2020/21</a>


  </div>
</div>



		</div>	






		<div style="width:410px;background-color:#f0f0f0;margin-top:4px;text-align:left;float:left;">


    <!-- divisions list -->
	<!-- england - divisions: -->
	<table style="width:415px;cellspacing:0px;cellpadding:3px;border:0px;">
	<tr>		

	<td style='vertical-align:top;width:90px;'>


	<div class="dropdown" style="float:left;">
		<button class="dropbtn" style="height:26px;"><font style='font-size:14px;color:#222222;font-weight:normal;'>Statistics</font> <font color="#AAAAAA">&#9660;</font></button>
		<div class="dropdown-content" style="left:0; width:160px;">

            <a href="fstats.asp?league=england">Favourite Stats</a>

		&nbsp;<b>Tables</b>
            <a href="homeaway.asp?league=england">Home / Away tables</a>

            <a href="formtable.asp?league=england">Form tables</a>

            <a href="statsbymonth.asp?league=england">Tables by Date</a>

            <a href="halftime.asp?league=england">Half-time stats</a>

			<a href="table.asp?league=england&tid=cr">Corner stats</a>

                <a href="widetable.asp?league=england">Wide table</a>
            
            <a href="scorers.asp?league=england">Scorers table</a>

            <a href="table.asp?league=england&tid=rp">Points performance</a>
            <a href="table.asp?league=england&tid=pr">Performance rating</a>
            <a href="table.asp?league=england&tid=10">Run-in analysis</a>
			<a href="table.asp?league=england&tid=re">Relative form</a>
			<a href="table.asp?league=england&tid=pp">Projected points</a>
			<a href="table.asp?league=england&tid=ha">Home advantage</a>

            <a href="table.asp?league=england&tid=pw">Points Won/Lost</a>



           
            &nbsp;<b>Matches</b>           
            <a href="results.asp?league=england">Matches by date</a>
			
				<a href="results.asp?league=england&pmtype=round98">Matches by gameweek</a>
	
            <a href="table.asp?league=england&tid=v">Results grid</a>
			<a href="matchlist.asp?league=england">Results filter</a>
			

            <a href="table.asp?league=england&tid=g">Current streaks</a>            

           
            &nbsp;<b>Goals per match</b>                                  
            <a href="table.asp?league=england&tid=c">Over / Under</a>

            <a href="table.asp?league=england&tid=8">Total Goals</a>

            <a href="table.asp?league=england&tid=9">Goal ranges</a>
            <a href="table.asp?league=england&tid=d">Average goals</a>
            <a href="table.asp?league=england&tid=f">Scored / conceded</a>
            <a href="table.asp?league=england&tid=p">Both teams scored</a>
            <a href="table.asp?league=england&tid=e">Goal margins</a>
            
 
          
            &nbsp;<b>Goal timing</b>                                  
            <a href="table.asp?league=england&tid=j">Goals per 10 min.</a>
            <a href="table.asp?league=england&tid=k">Goals per 15 min.</a>
            <a href="firstgoal.asp?league=england">First Goal stats</a>
            
            		<a href="table.asp?league=england&tid=pa">Scored in both halves</a>
            
            &nbsp;<b>Leading / losing</b>                                  
            <a href="table.asp?league=england&tid=t">Lead durations</a>
            <a href="table.asp?league=england&tid=sc">Scored / conceded first</a>
            <a href="table.asp?league=england&tid=h">Leading / Trailing at HT</a>
            <a href="table.asp?league=england&tid=u">Goal types</a>            
            <a href="table.asp?league=england&tid=x">Equalisers scored</a>
            <a href="table.asp?league=england&tid=w">Equalisers conceded</a>

            </div>
         </div>

	</td>


	
	<td style='vertical-align:top;width:165px;'>	

		<div class="dropdown" style="margin-left:5px;float:left;">


		<button class="dropbtn" style='height:26px;'>
		<img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAALCAIAAAD5gJpuAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAGCSURBVHjaYvz48SMDEvj3j+Hfty/npKX/MTAY3L7NwMf3DxUABBALUBEfHx+Q/P//P1QPJ7t6UdG/P3+EpKQY2Nj+I4Fnz54BBBALRBFcNUj4378fDx78+/3739+/QBvhqhkZGf/8+QMQQCxoqiEkUPX/X7+BShiQjAc7+B9AALE8SEmRi4//++ED0Dyg2Qx///77+fPfr1//f/9+PWMGUBVQHCT15w+LkNCF3FyAAGJ5t3q1oJLSr8eP///+8//Pb5BLgMYDyV+/3q1Z8w/MAPrn/69f7AoKzxgYAAKIhcventvIiE1e/t+/vwx/QIYBbfi4dStQKa+LC9QGoIa/f1lFRAT27QMIIMa3b9/y8/PDXQ/ywI8ft1xdgQar7tsHDyWgLNDTd+7cAQggFqA/kL0LkQQ5A4j+/mVE8jEQAEMJIIBAGuCqIaKMDAxsMjJAJzEyMQFNhYlBZQECCKTh1atXyHH56927Q1u2/GJgcLh0iUFICOSEf//+gB0CBAABBgAC4UQezUonUAAAAABJRU5ErkJggg==' width='15' height='11' alt='england'>&nbsp;&nbsp;<font style='font-size:14px;color:#222222;font-weight:normal;'>other competitions</font> <font color='#AAAAAA'>&#9660;</font></button>
		
		
		<div class="dropdown-content" style="left:0;width: 200px;">
<a href='latest.asp?league=england'>Premier League</a><a href='latest.asp?league=england2'>Championship</a><a href='latest.asp?league=england3'>League One</a><a href='latest.asp?league=england4'>League Two</a><a href='latest.asp?league=england5'>National League</a><a href='latest.asp?league=england6'>National L. North</a><a href='latest.asp?league=england7'>National L. South</a><a href='latest.asp?league=england8'>Isthmian league</a><a href='latest.asp?league=england9'>Northern league</a><a href='latest.asp?league=england10'>Southern Central</a><a href='latest.asp?league=england11'>Southern South</a><a href='latest.asp?league=england15'>Premier League 2</a><a href='latest.asp?league=england17'>Women Super League</a>
		</div>




		</div>
	</td>
	<td style='vertical-align:top;width:160px;'>
	

	<div class="dropdown" style="margin-left:8px;float:left;">
		<button class="dropbtn" style="height:26px;"><font style="font-size:14px;color:#222222;font-weight:normal;">Teams</font> <font color="#AAAAAA">&#9660;</font></button>
		<div class="dropdown-content" style="left:0; width:120px;">
	                <a href='teamstats.asp?league=england&stats=u324-arsenal'>Arsenal</a>
<a href='teamstats.asp?league=england&stats=u322-aston-villa'>Aston Villa</a>
<a href='teamstats.asp?league=england&stats=u7571-bournemouth'>Bournemouth</a>
<a href='teamstats.asp?league=england&stats=u342-brentford'>Brentford</a>
<a href='teamstats.asp?league=england&stats=u337-brighton'>Brighton</a>
<a href='teamstats.asp?league=england&stats=u319-burnley'>Burnley</a>
<a href='teamstats.asp?league=england&stats=u338-chelsea'>Chelsea</a>
<a href='teamstats.asp?league=england&stats=u325-crystal-palace'>Crystal Palace</a>
<a href='teamstats.asp?league=england&stats=u334-everton'>Everton</a>
<a href='teamstats.asp?league=england&stats=u7591-fulham'>Fulham</a>
<a href='teamstats.asp?league=england&stats=u328-leeds-utd'>Leeds Utd</a>
<a href='teamstats.asp?league=england&stats=u327-liverpool'>Liverpool</a>
<a href='teamstats.asp?league=england&stats=u321-manchester-city'>Manchester City</a>
<a href='teamstats.asp?league=england&stats=u320-manchester-utd'>Manchester Utd</a>
<a href='teamstats.asp?league=england&stats=u330-newcastle-utd'>Newcastle Utd</a>
<a href='teamstats.asp?league=england&stats=u7594-nottm-forest'>Nottm Forest</a>
<a href='teamstats.asp?league=england&stats=u7691-sunderland'>Sunderland</a>
<a href='teamstats.asp?league=england&stats=u333-tottenham'>Tottenham</a>
<a href='teamstats.asp?league=england&stats=u329-west-ham-utd'>West Ham Utd</a>
<a href='teamstats.asp?league=england&stats=u336-wolverhampton'>Wolverhampton</a>
         
		</div>
	</div>

	</td>
	</tr>        
	</table>   



		
		</div>

		
	
</div> <!-- end of row -->	
	


<div style="background-color:#f0f0f0;text-align:left;padding-top:0px;height:90px;">



	<table width="100%">





















	<tr>
	<td colspan="3" style="background-color:#f0f0f0;height:30px;">




	<table cellspacing='4' cellpadding='2' bgcolor='#f0f0f0' border='0'>
	<tr bgcolor='#f0f0f0'>
	<td valign='middle'>
		<!-- league menu -->		
												
	<a href="latest.asp?league=england" class="SmallButton" style="margin-right:6px;"><font style="color:#222222;">LATEST</font></a>

	<a href="results.asp?league=england" class="SmallButton" style="margin-right:6px;"><font style="color:#222222;">MATCHES</font></a>
	


		<a href="formtable.asp?league=england" class="SmallButton" style="margin-right:6px;"><font style="color:#222222;">FORM</font></a>

	<a href="h2h_selection.asp?league=england" class="SmallButton" style="margin-right:6px;"><font style="color:#222222;">H2H</font></a>




		<a href="trends.asp?league=england" class="SmallButton" style="margin-right:6px;"><font style="color:blue;">GOALS</font></a>
					
					

		<a href="halftime.asp?league=england" class="SmallButton" style="margin-right:6px;"><font style="color:#222222;">HALF-TIME</font></a>


		<a href="timing.asp?league=england" class="SmallButton" style="margin-right:6px;"><font style="color:#222222;">TIMING</font></a>


		<a href="firstgoal.asp?league=england" class="SmallButton" style="margin-right:6px;"><font style="color:#222222;">FIRST GOAL</font></a>
		
		<a href="fstats.asp?league=england" class="SmallButton" style="background-color:#D9EBFD;"><font style="color:#222222;">FAVOURITE</font></a>

						
		</td></tr>
		</table>		
		
		





</td></tr>






























	<tr>
	<td style="width:6px;background-color:#f0f0f0;height:36px;padding-left:8px;">
	&#128269;
	</td>
	<td style="width:520px;background-color:#f0f0f0;height:36px;padding-left:4px;">
		
		
		
		
		
		<div class="form-statsearch" style='background-color:#ffffff;margin-top:0px;border: 1px solid #cccccc;'>
			<input type="text" name="thestat" id="autocomplete3" max-length="40" value="Search statistics in current league..." onfocus="if (this.value == 'Search statistics in current league...') {this.value = '';}" onblur="if (this.value == '') {this.value = 'Search statistics in current league...';}" style="border:none;width:500px;height:18px;padding-left:7px;padding-top:2px;font-size:14px;color:#666666;background-color:#ffffff;" />
		</div>

	</td><td bgcolor='#f0f0f0' style='padding-left:7px;'>
	</td></tr></table>






	
</div>



		<table width="98%" cellspacing="0" cellpadding="4" border="0" style="margin-top:10px;margin-left:10px;padding-top:4px;padding-bottom:0px;border:1px solid #aaaaaa;border-radius:6px;overflow:hidden;">
		<tr><td valign="middle">		
		<h1 style="font-size:18px;font-weight:normal;color:#111111;padding-left:6px;padding-top:2px;padding-bottom:6px;">Premier League corner stats</h1>
		</td></tr>
		</table>


<script src="sorttable.js"></script>

<div id='hbanner' style='width:974px;height:104px;background-color:#ffffff;text-align:center;padding: 10px 8px 6px 8px;'><div style='text-align:left;font-size:10px;color:#666666;padding-top:4px;padding-left:454px;padding-bottom:2px;'>advertisement</div>
<!-- T970FB -->
<ins class="adsbygoogle"
     style="display:inline-block;width:970px;height:90px"
     data-ad-client="ca-pub-3910539363731532"
     data-ad-slot="7505969288"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script></div>

<div class="row" style="margin-bottom:50px;">

            <div class="twelve columns">	
            
            <table width='100%' cellpadding='0' cellspacing='1' border='0' style='padding-top:20px;'>
            <tr>

<td width='200' valign='top' style='padding-left:16px;padding-top:1px;'><br><h2 style='text-align:left;padding-left:2px;margin-bottom:8px;'>Visual table</h2>
<table width='100%' cellspacing='0' cellpadding='1' border='0' style='border:1px solid #aaaaaa;overflow:hidden;'>
<tr style='pointer-events:none;'>
<td width='69%' height='25' align='center' colspan='2'>&nbsp;</td>
<td width='14%' align='center'><font color='green'>GP</font></td>
</td>
<td width='17%' align='center'>Pts</td>
</tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>1</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u324-arsenal' title='Arsenal stats' target='_top'>Arsenal</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>85</b></td>
</tr>
<tr bgcolor='#ffffff' height='63'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>2</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u321-manchester-city' title='Manchester City stats' target='_top'>Manchester City</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>78</b></td>
</tr>
<tr bgcolor='#ffffff' height='63'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>3</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u320-manchester-utd' title='Manchester Utd stats' target='_top'>Manchester Utd</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>71</b></td>
</tr>
<tr bgcolor='#ffffff' height='54'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>4</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u322-aston-villa' title='Aston Villa stats' target='_top'>Aston Villa</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>65</b></td>
</tr>
<tr bgcolor='#ffffff' height='45'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>5</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u327-liverpool' title='Liverpool stats' target='_top'>Liverpool</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>60</b></td>
</tr>
<tr bgcolor='#ffffff' height='27'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>6</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u7571-bournemouth' title='Bournemouth stats' target='_top'>Bournemouth</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>57</b></td>
</tr>
<tr bgcolor='#ffffff' height='27'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>7</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u7691-sunderland' title='Sunderland stats' target='_top'>Sunderland</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>54</b></td>
</tr>
<tr bgcolor='#ffffff' height='9'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>8</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u337-brighton' title='Brighton stats' target='_top'>Brighton</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>53</b></td>
</tr>
<tr bgcolor='#ffffff' height='0'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>9</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u342-brentford' title='Brentford stats' target='_top'>Brentford</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>53</b></td>
</tr>
<tr bgcolor='#ffffff' height='9'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>10</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u338-chelsea' title='Chelsea stats' target='_top'>Chelsea</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>52</b></td>
</tr>
<tr bgcolor='#ffffff' height='0'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>11</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u7591-fulham' title='Fulham stats' target='_top'>Fulham</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>52</b></td>
</tr>
<tr bgcolor='#ffffff' height='27'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>12</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u330-newcastle-utd' title='Newcastle Utd stats' target='_top'>Newcastle Utd</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>49</b></td>
</tr>
<tr bgcolor='#ffffff' height='0'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>13</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u334-everton' title='Everton stats' target='_top'>Everton</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>49</b></td>
</tr>
<tr bgcolor='#ffffff' height='18'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>14</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u328-leeds-utd' title='Leeds Utd stats' target='_top'>Leeds Utd</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>47</b></td>
</tr>
<tr bgcolor='#ffffff' height='18'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>15</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u325-crystal-palace' title='Crystal Palace stats' target='_top'>Crystal Palace</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>45</b></td>
</tr>
<tr bgcolor='#ffffff' height='9'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>16</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u7594-nottm-forest' title='Nottm Forest stats' target='_top'>Nottm Forest</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>44</b></td>
</tr>
<tr bgcolor='#ffffff' height='27'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>17</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u333-tottenham' title='Tottenham stats' target='_top'>Tottenham</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>41</b></td>
</tr>
<tr bgcolor='#ffffff' height='18'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>18</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u329-west-ham-utd' title='West Ham Utd stats' target='_top'>West Ham Utd</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>39</b></td>
</tr>
<tr bgcolor='#ffffff' height='153'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>19</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u319-burnley' title='Burnley stats' target='_top'>Burnley</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>22</b></td>
</tr>
<tr bgcolor='#ffffff' height='18'><td colspan='4'></td></tr>
<tr bgcolor='#f0f0f0'>
<td width='8%' align='center' bgcolor='dedede' height='18'><font color='#444444'><b>20</b></font></td>
<td width='61%' align='left'>&nbsp;<a href='teamstats.asp?league=england&stats=u336-wolverhampton' title='Wolverhampton stats' target='_top'>Wolverhampton</a></td>
<td width='14%' align='center'><font color='green'>38</font></td>
<td width='17%' align='center'><b>20</b></td>
</tr>
</table>
<br></td><td valign='top' align='center' style='padding-left:40px;padding-right:16px;'><br>        
       
	<table width="100%" border="0" cellpadding="0" cellspacing="0">
	<tr height="32"><td valign="middle">
	<font color="#444444" style="font-size:18px;font-weight:bold;">Corners</font>
	</td></tr>
	<tr><td style="vertical-align:top;text-align:center;padding-bottom:8px;"> 

<div class='tabs'>
<input type='radio' name='eng_COR' id='eng_COR_1' checked='checked'>
<label for='eng_COR_1'>Total</label>
<div class='tab'><br>
<h2 style='color:#444444;text-align:left;background-color:#f8f8f8;height:18px;padding-top:6px;padding-bottom:0px;margin-left:0px;'>Corners (home and away)</h2>
<table id='btable' width='100%' cellspacing='0' cellpadding='0'>
<tr class='trow2'>
<th width='120' rowspan='2' align='center'>Matches of...</th>
<th rowspan='2' align='center'>GP</th>

<th colspan='4' height='30' align='center' valign='middle'>
Corners per match
</th>
<th colspan='3' height='30' align='center' valign='middle'>
Total corners (For + Against)
</th>

</tr>
<tr class='trow2' height='30'>
<th align='center'><b>For</b></th>
<th align='center'><b>Against</b></th>
<th colspan='2' align='center'><b>Total</b></th>

<th align='center'><span title='Total match corners (team corner + opponent corner) over 8.5'><b>8.5+</b></span></th>
<th align='center'><span title='Total match corners (team corner + opponent corner) over 9.5'><b>9.5+</b></span></th>
<th align='center'><span title='Total match corners (team corner + opponent corner) over 10.5'><b>10.5+</b></span></th>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u324-arsenal' target='_top'>Arsenal</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
5.68</font></td>
<td align='center'><font color='#C70039'>
3.32</font></td>

<td>
<div style='width:36.00px;' class='bargray'></div>
</td>

<td align='left'><b>9.00</b></td>

<td align='center'>
<span title='18 / 38'>47%</span></td>
<td align='center'>
<span title='16 / 38'>42%</span></td>
<td align='center'>
<span title='15 / 38'>39%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u322-aston-villa' target='_top'>Aston Villa</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
5.24</font></td>
<td align='center'><font color='#C70039'>
4.92</font></td>

<td>
<div style='width:40.63px;' class='bargray'></div>
</td>

<td align='left'><b>10.16</b></td>

<td align='center'>
<span title='29 / 38'>76%</span></td>
<td align='center'>
<span title='26 / 38'>68%</span></td>
<td align='center'>
<span title='18 / 38'>47%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7571-bournemouth' target='_top'>Bournemouth</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
5.58</font></td>
<td align='center'><font color='#C70039'>
5.29</font></td>

<td>
<div style='width:43.47px;' class='bargray'></div>
</td>

<td align='left'><b>10.87</b></td>

<td align='center'>
<span title='28 / 38'>74%</span></td>
<td align='center'>
<span title='24 / 38'>63%</span></td>
<td align='center'>
<span title='21 / 38'>55%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u342-brentford' target='_top'>Brentford</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
4.79</font></td>
<td align='center'><font color='#C70039'>
5.37</font></td>

<td>
<div style='width:40.63px;' class='bargray'></div>
</td>

<td align='left'><b>10.16</b></td>

<td align='center'>
<span title='26 / 38'>68%</span></td>
<td align='center'>
<span title='24 / 38'>63%</span></td>
<td align='center'>
<span title='21 / 38'>55%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u337-brighton' target='_top'>Brighton</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
4.87</font></td>
<td align='center'><font color='#C70039'>
4.82</font></td>

<td>
<div style='width:38.74px;' class='bargray'></div>
</td>

<td align='left'><b>9.68</b></td>

<td align='center'>
<span title='23 / 38'>61%</span></td>
<td align='center'>
<span title='22 / 38'>58%</span></td>
<td align='center'>
<span title='17 / 38'>45%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u319-burnley' target='_top'>Burnley</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
3.63</font></td>
<td align='center'><font color='#C70039'>
5.95</font></td>

<td>
<div style='width:38.32px;' class='bargray'></div>
</td>

<td align='left'><b>9.58</b></td>

<td align='center'>
<span title='22 / 38'>58%</span></td>
<td align='center'>
<span title='20 / 38'>53%</span></td>
<td align='center'>
<span title='14 / 38'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u338-chelsea' target='_top'>Chelsea</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
5.95</font></td>
<td align='center'><font color='#C70039'>
4.29</font></td>

<td>
<div style='width:40.95px;' class='bargray'></div>
</td>

<td align='left'><b>10.24</b></td>

<td align='center'>
<span title='28 / 38'>74%</span></td>
<td align='center'>
<span title='25 / 38'>66%</span></td>
<td align='center'>
<span title='19 / 38'>50%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u325-crystal-palace' target='_top'>Crystal Palace</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
4.18</font></td>
<td align='center'><font color='#C70039'>
5.24</font></td>

<td>
<div style='width:37.68px;' class='bargray'></div>
</td>

<td align='left'><b>9.42</b></td>

<td align='center'>
<span title='21 / 38'>55%</span></td>
<td align='center'>
<span title='18 / 38'>47%</span></td>
<td align='center'>
<span title='14 / 38'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u334-everton' target='_top'>Everton</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
4.42</font></td>
<td align='center'><font color='#C70039'>
5.13</font></td>

<td>
<div style='width:38.21px;' class='bargray'></div>
</td>

<td align='left'><b>9.55</b></td>

<td align='center'>
<span title='25 / 38'>66%</span></td>
<td align='center'>
<span title='17 / 38'>45%</span></td>
<td align='center'>
<span title='15 / 38'>39%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7591-fulham' target='_top'>Fulham</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
4.92</font></td>
<td align='center'><font color='#C70039'>
5.53</font></td>

<td>
<div style='width:41.79px;' class='bargray'></div>
</td>

<td align='left'><b>10.45</b></td>

<td align='center'>
<span title='30 / 38'>79%</span></td>
<td align='center'>
<span title='25 / 38'>66%</span></td>
<td align='center'>
<span title='18 / 38'>47%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u328-leeds-utd' target='_top'>Leeds Utd</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
4.42</font></td>
<td align='center'><font color='#C70039'>
5.08</font></td>

<td>
<div style='width:38.00px;' class='bargray'></div>
</td>

<td align='left'><b>9.50</b></td>

<td align='center'>
<span title='24 / 38'>63%</span></td>
<td align='center'>
<span title='20 / 38'>53%</span></td>
<td align='center'>
<span title='15 / 38'>39%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u327-liverpool' target='_top'>Liverpool</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
6.11</font></td>
<td align='center'><font color='#C70039'>
4.39</font></td>

<td>
<div style='width:42.00px;' class='bargray'></div>
</td>

<td align='left'><b>10.50</b></td>

<td align='center'>
<span title='28 / 38'>74%</span></td>
<td align='center'>
<span title='21 / 38'>55%</span></td>
<td align='center'>
<span title='18 / 38'>47%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u321-manchester-city' target='_top'>Manchester City</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
6.42</font></td>
<td align='center'><font color='#C70039'>
3.82</font></td>

<td>
<div style='width:40.95px;' class='bargray'></div>
</td>

<td align='left'><b>10.24</b></td>

<td align='center'>
<span title='26 / 38'>68%</span></td>
<td align='center'>
<span title='21 / 38'>55%</span></td>
<td align='center'>
<span title='17 / 38'>45%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u320-manchester-utd' target='_top'>Manchester Utd</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
4.76</font></td>
<td align='center'><font color='#C70039'>
4.87</font></td>

<td>
<div style='width:38.53px;' class='bargray'></div>
</td>

<td align='left'><b>9.63</b></td>

<td align='center'>
<span title='21 / 38'>55%</span></td>
<td align='center'>
<span title='20 / 38'>53%</span></td>
<td align='center'>
<span title='14 / 38'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u330-newcastle-utd' target='_top'>Newcastle Utd</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
6.05</font></td>
<td align='center'><font color='#C70039'>
4.92</font></td>

<td>
<div style='width:43.89px;' class='bargray'></div>
</td>

<td align='left'><b>10.97</b></td>

<td align='center'>
<span title='29 / 38'>76%</span></td>
<td align='center'>
<span title='23 / 38'>61%</span></td>
<td align='center'>
<span title='19 / 38'>50%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7594-nottm-forest' target='_top'>Nottm Forest</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
5.21</font></td>
<td align='center'><font color='#C70039'>
4.82</font></td>

<td>
<div style='width:40.11px;' class='bargray'></div>
</td>

<td align='left'><b>10.03</b></td>

<td align='center'>
<span title='29 / 38'>76%</span></td>
<td align='center'>
<span title='22 / 38'>58%</span></td>
<td align='center'>
<span title='16 / 38'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7691-sunderland' target='_top'>Sunderland</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
3.63</font></td>
<td align='center'><font color='#C70039'>
5.13</font></td>

<td>
<div style='width:35.05px;' class='bargray'></div>
</td>

<td align='left'><b>8.76</b></td>

<td align='center'>
<span title='21 / 38'>55%</span></td>
<td align='center'>
<span title='16 / 38'>42%</span></td>
<td align='center'>
<span title='11 / 38'>29%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u333-tottenham' target='_top'>Tottenham</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
5.50</font></td>
<td align='center'><font color='#C70039'>
4.82</font></td>

<td>
<div style='width:41.26px;' class='bargray'></div>
</td>

<td align='left'><b>10.32</b></td>

<td align='center'>
<span title='22 / 38'>58%</span></td>
<td align='center'>
<span title='20 / 38'>53%</span></td>
<td align='center'>
<span title='16 / 38'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u329-west-ham-utd' target='_top'>West Ham Utd</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
4.92</font></td>
<td align='center'><font color='#C70039'>
6.08</font></td>

<td>
<div style='width:44.00px;' class='bargray'></div>
</td>

<td align='left'><b>11.00</b></td>

<td align='center'>
<span title='27 / 38'>71%</span></td>
<td align='center'>
<span title='25 / 38'>66%</span></td>
<td align='center'>
<span title='21 / 38'>55%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u336-wolverhampton' target='_top'>Wolverhampton</a>&nbsp;</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><font color='blue'>
3.39</font></td>
<td align='center'><font color='#C70039'>
5.92</font></td>

<td>
<div style='width:37.26px;' class='bargray'></div>
</td>

<td align='left'><b>9.32</b></td>

<td align='center'>
<span title='25 / 38'>66%</span></td>
<td align='center'>
<span title='21 / 38'>55%</span></td>
<td align='center'>
<span title='13 / 38'>34%</span></td>

</tr>

<tr><td colspan=10></td></tr>
<tr bgcolor='#e0e0e0' style='pointer-events:none;'><td height='25' colspan='2' style='padding-left:5px;'><b>
League average
</b></td>
<td colspan='4'></td>
<td align='center'>
66%
</td>
<td align='center'>
56%
</td>
<td align='center'>
44%
</td>
</tr>

</table>
</div>
<input type='radio' name='eng_COR' id='eng_COR_2'>
<label for='eng_COR_2'>Home</label>
<div class='tab'><br>
<h2 style='color:#444444;text-align:left;background-color:#f8f8f8;height:18px;padding-top:6px;padding-bottom:0px;margin-left:0px;'>Corners (home)</h2>
<table id='btable' width='100%' cellspacing='0' cellpadding='0'>
<tr class='trow2'>
<th width='120' rowspan='2' align='center'>Home matches of...</th>
<th rowspan='2' align='center'>GP</th>

<th colspan='4' height='30' align='center' valign='middle'>
Corners per match
</th>
<th colspan='3' height='30' align='center' valign='middle'>
Total corners (For + Against)
</th>

</tr>
<tr class='trow2' height='30'>
<th align='center'><b>For</b></th>
<th align='center'><b>Against</b></th>
<th colspan='2' align='center'><b>Total</b></th>

<th align='center'><span title='Total match corners (team corner + opponent corner) over 8.5'><b>8.5+</b></span></th>
<th align='center'><span title='Total match corners (team corner + opponent corner) over 9.5'><b>9.5+</b></span></th>
<th align='center'><span title='Total match corners (team corner + opponent corner) over 10.5'><b>10.5+</b></span></th>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u324-arsenal' target='_top'>Arsenal</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.89</font></td>
<td align='center'><font color='#C70039'>
2.79</font></td>

<td>
<div style='width:34.74px;' class='bargray'></div>
</td>

<td align='left'><b>8.68</b></td>

<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u322-aston-villa' target='_top'>Aston Villa</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.53</font></td>
<td align='center'><font color='#C70039'>
4.95</font></td>

<td>
<div style='width:41.89px;' class='bargray'></div>
</td>

<td align='left'><b>10.47</b></td>

<td align='center'>
<span title='17 / 19'>89%</span></td>
<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7571-bournemouth' target='_top'>Bournemouth</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
6.00</font></td>
<td align='center'><font color='#C70039'>
4.00</font></td>

<td>
<div style='width:40.00px;' class='bargray'></div>
</td>

<td align='left'><b>10.00</b></td>

<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u342-brentford' target='_top'>Brentford</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.37</font></td>
<td align='center'><font color='#C70039'>
4.63</font></td>

<td>
<div style='width:36.00px;' class='bargray'></div>
</td>

<td align='left'><b>9.00</b></td>

<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u337-brighton' target='_top'>Brighton</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.95</font></td>
<td align='center'><font color='#C70039'>
4.53</font></td>

<td>
<div style='width:37.89px;' class='bargray'></div>
</td>

<td align='left'><b>9.47</b></td>

<td align='center'>
<span title='9 / 19'>47%</span></td>
<td align='center'>
<span title='9 / 19'>47%</span></td>
<td align='center'>
<span title='9 / 19'>47%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u319-burnley' target='_top'>Burnley</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
3.74</font></td>
<td align='center'><font color='#C70039'>
5.89</font></td>

<td>
<div style='width:38.53px;' class='bargray'></div>
</td>

<td align='left'><b>9.63</b></td>

<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u338-chelsea' target='_top'>Chelsea</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
6.84</font></td>
<td align='center'><font color='#C70039'>
3.89</font></td>

<td>
<div style='width:42.95px;' class='bargray'></div>
</td>

<td align='left'><b>10.74</b></td>

<td align='center'>
<span title='15 / 19'>79%</span></td>
<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='11 / 19'>58%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u325-crystal-palace' target='_top'>Crystal Palace</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.37</font></td>
<td align='center'><font color='#C70039'>
4.37</font></td>

<td>
<div style='width:34.95px;' class='bargray'></div>
</td>

<td align='left'><b>8.74</b></td>

<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>
<td align='center'>
<span title='5 / 19'>26%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u334-everton' target='_top'>Everton</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.95</font></td>
<td align='center'><font color='#C70039'>
4.63</font></td>

<td>
<div style='width:38.32px;' class='bargray'></div>
</td>

<td align='left'><b>9.58</b></td>

<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7591-fulham' target='_top'>Fulham</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.47</font></td>
<td align='center'><font color='#C70039'>
5.68</font></td>

<td>
<div style='width:44.63px;' class='bargray'></div>
</td>

<td align='left'><b>11.16</b></td>

<td align='center'>
<span title='16 / 19'>84%</span></td>
<td align='center'>
<span title='15 / 19'>79%</span></td>
<td align='center'>
<span title='14 / 19'>74%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u328-leeds-utd' target='_top'>Leeds Utd</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.58</font></td>
<td align='center'><font color='#C70039'>
4.21</font></td>

<td>
<div style='width:39.16px;' class='bargray'></div>
</td>

<td align='left'><b>9.79</b></td>

<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u327-liverpool' target='_top'>Liverpool</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
6.26</font></td>
<td align='center'><font color='#C70039'>
4.79</font></td>

<td>
<div style='width:44.21px;' class='bargray'></div>
</td>

<td align='left'><b>11.05</b></td>

<td align='center'>
<span title='15 / 19'>79%</span></td>
<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u321-manchester-city' target='_top'>Manchester City</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
7.11</font></td>
<td align='center'><font color='#C70039'>
3.32</font></td>

<td>
<div style='width:41.68px;' class='bargray'></div>
</td>

<td align='left'><b>10.42</b></td>

<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='9 / 19'>47%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u320-manchester-utd' target='_top'>Manchester Utd</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.26</font></td>
<td align='center'><font color='#C70039'>
4.47</font></td>

<td>
<div style='width:38.95px;' class='bargray'></div>
</td>

<td align='left'><b>9.74</b></td>

<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u330-newcastle-utd' target='_top'>Newcastle Utd</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
6.74</font></td>
<td align='center'><font color='#C70039'>
4.95</font></td>

<td>
<div style='width:46.74px;' class='bargray'></div>
</td>

<td align='left'><b>11.68</b></td>

<td align='center'>
<span title='15 / 19'>79%</span></td>
<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='11 / 19'>58%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7594-nottm-forest' target='_top'>Nottm Forest</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
6.00</font></td>
<td align='center'><font color='#C70039'>
3.89</font></td>

<td>
<div style='width:39.58px;' class='bargray'></div>
</td>

<td align='left'><b>9.89</b></td>

<td align='center'>
<span title='15 / 19'>79%</span></td>
<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7691-sunderland' target='_top'>Sunderland</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
3.89</font></td>
<td align='center'><font color='#C70039'>
4.68</font></td>

<td>
<div style='width:34.32px;' class='bargray'></div>
</td>

<td align='left'><b>8.58</b></td>

<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>
<td align='center'>
<span title='5 / 19'>26%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u333-tottenham' target='_top'>Tottenham</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
6.21</font></td>
<td align='center'><font color='#C70039'>
5.32</font></td>

<td>
<div style='width:46.11px;' class='bargray'></div>
</td>

<td align='left'><b>11.53</b></td>

<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='11 / 19'>58%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u329-west-ham-utd' target='_top'>West Ham Utd</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.32</font></td>
<td align='center'><font color='#C70039'>
5.47</font></td>

<td>
<div style='width:43.16px;' class='bargray'></div>
</td>

<td align='left'><b>10.79</b></td>

<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='9 / 19'>47%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u336-wolverhampton' target='_top'>Wolverhampton</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
3.11</font></td>
<td align='center'><font color='#C70039'>
5.32</font></td>

<td>
<div style='width:33.68px;' class='bargray'></div>
</td>

<td align='left'><b>8.42</b></td>

<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>
<td align='center'>
<span title='5 / 19'>26%</span></td>

</tr>

<tr><td colspan=10></td></tr>
<tr bgcolor='#e0e0e0' style='pointer-events:none;'><td height='25' colspan='2' style='padding-left:5px;'><b>
League average
</b></td>
<td colspan='4'></td>
<td align='center'>
66%
</td>
<td align='center'>
56%
</td>
<td align='center'>
44%
</td>
</tr>

</table>
</div>
<input type='radio' name='eng_COR' id='eng_COR_3'>
<label for='eng_COR_3'>Away</label>
<div class='tab'><br>
<h2 style='color:#444444;text-align:left;background-color:#f8f8f8;height:18px;padding-top:6px;padding-bottom:0px;margin-left:0px;'>Corners (away)</h2>
<table id='btable' width='100%' cellspacing='0' cellpadding='0'>
<tr class='trow2'>
<th width='120' rowspan='2' align='center'>Away matches of...</th>
<th rowspan='2' align='center'>GP</th>

<th colspan='4' height='30' align='center' valign='middle'>
Corners per match
</th>
<th colspan='3' height='30' align='center' valign='middle'>
Total corners (For + Against)
</th>

</tr>
<tr class='trow2' height='30'>
<th align='center'><b>For</b></th>
<th align='center'><b>Against</b></th>
<th colspan='2' align='center'><b>Total</b></th>

<th align='center'><span title='Total match corners (team corner + opponent corner) over 8.5'><b>8.5+</b></span></th>
<th align='center'><span title='Total match corners (team corner + opponent corner) over 9.5'><b>9.5+</b></span></th>
<th align='center'><span title='Total match corners (team corner + opponent corner) over 10.5'><b>10.5+</b></span></th>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u324-arsenal' target='_top'>Arsenal</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.47</font></td>
<td align='center'><font color='#C70039'>
3.84</font></td>

<td>
<div style='width:37.26px;' class='bargray'></div>
</td>

<td align='left'><b>9.32</b></td>

<td align='center'>
<span title='8 / 19'>42%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u322-aston-villa' target='_top'>Aston Villa</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.95</font></td>
<td align='center'><font color='#C70039'>
4.89</font></td>

<td>
<div style='width:39.37px;' class='bargray'></div>
</td>

<td align='left'><b>9.84</b></td>

<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7571-bournemouth' target='_top'>Bournemouth</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.16</font></td>
<td align='center'><font color='#C70039'>
6.58</font></td>

<td>
<div style='width:46.95px;' class='bargray'></div>
</td>

<td align='left'><b>11.74</b></td>

<td align='center'>
<span title='17 / 19'>89%</span></td>
<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='13 / 19'>68%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u342-brentford' target='_top'>Brentford</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.21</font></td>
<td align='center'><font color='#C70039'>
6.11</font></td>

<td>
<div style='width:45.26px;' class='bargray'></div>
</td>

<td align='left'><b>11.32</b></td>

<td align='center'>
<span title='15 / 19'>79%</span></td>
<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='13 / 19'>68%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u337-brighton' target='_top'>Brighton</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.79</font></td>
<td align='center'><font color='#C70039'>
5.11</font></td>

<td>
<div style='width:39.58px;' class='bargray'></div>
</td>

<td align='left'><b>9.89</b></td>

<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u319-burnley' target='_top'>Burnley</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
3.53</font></td>
<td align='center'><font color='#C70039'>
6.00</font></td>

<td>
<div style='width:38.11px;' class='bargray'></div>
</td>

<td align='left'><b>9.53</b></td>

<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u338-chelsea' target='_top'>Chelsea</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.05</font></td>
<td align='center'><font color='#C70039'>
4.68</font></td>

<td>
<div style='width:38.95px;' class='bargray'></div>
</td>

<td align='left'><b>9.74</b></td>

<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u325-crystal-palace' target='_top'>Crystal Palace</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.00</font></td>
<td align='center'><font color='#C70039'>
6.11</font></td>

<td>
<div style='width:40.42px;' class='bargray'></div>
</td>

<td align='left'><b>10.11</b></td>

<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='9 / 19'>47%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u334-everton' target='_top'>Everton</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
3.89</font></td>
<td align='center'><font color='#C70039'>
5.63</font></td>

<td>
<div style='width:38.11px;' class='bargray'></div>
</td>

<td align='left'><b>9.53</b></td>

<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7591-fulham' target='_top'>Fulham</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.37</font></td>
<td align='center'><font color='#C70039'>
5.37</font></td>

<td>
<div style='width:38.95px;' class='bargray'></div>
</td>

<td align='left'><b>9.74</b></td>

<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='4 / 19'>21%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u328-leeds-utd' target='_top'>Leeds Utd</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
3.26</font></td>
<td align='center'><font color='#C70039'>
5.95</font></td>

<td>
<div style='width:36.84px;' class='bargray'></div>
</td>

<td align='left'><b>9.21</b></td>

<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u327-liverpool' target='_top'>Liverpool</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.95</font></td>
<td align='center'><font color='#C70039'>
4.00</font></td>

<td>
<div style='width:39.79px;' class='bargray'></div>
</td>

<td align='left'><b>9.95</b></td>

<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u321-manchester-city' target='_top'>Manchester City</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.74</font></td>
<td align='center'><font color='#C70039'>
4.32</font></td>

<td>
<div style='width:40.21px;' class='bargray'></div>
</td>

<td align='left'><b>10.05</b></td>

<td align='center'>
<span title='12 / 19'>63%</span></td>
<td align='center'>
<span title='9 / 19'>47%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u320-manchester-utd' target='_top'>Manchester Utd</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.26</font></td>
<td align='center'><font color='#C70039'>
5.26</font></td>

<td>
<div style='width:38.11px;' class='bargray'></div>
</td>

<td align='left'><b>9.53</b></td>

<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='7 / 19'>37%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u330-newcastle-utd' target='_top'>Newcastle Utd</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
5.37</font></td>
<td align='center'><font color='#C70039'>
4.89</font></td>

<td>
<div style='width:41.05px;' class='bargray'></div>
</td>

<td align='left'><b>10.26</b></td>

<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7594-nottm-forest' target='_top'>Nottm Forest</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.42</font></td>
<td align='center'><font color='#C70039'>
5.74</font></td>

<td>
<div style='width:40.63px;' class='bargray'></div>
</td>

<td align='left'><b>10.16</b></td>

<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='10 / 19'>53%</span></td>
<td align='center'>
<span title='9 / 19'>47%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u7691-sunderland' target='_top'>Sunderland</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
3.37</font></td>
<td align='center'><font color='#C70039'>
5.58</font></td>

<td>
<div style='width:35.79px;' class='bargray'></div>
</td>

<td align='left'><b>8.95</b></td>

<td align='center'>
<span title='11 / 19'>58%</span></td>
<td align='center'>
<span title='9 / 19'>47%</span></td>
<td align='center'>
<span title='6 / 19'>32%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u333-tottenham' target='_top'>Tottenham</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.79</font></td>
<td align='center'><font color='#C70039'>
4.32</font></td>

<td>
<div style='width:36.42px;' class='bargray'></div>
</td>

<td align='left'><b>9.11</b></td>

<td align='center'>
<span title='9 / 19'>47%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>
<td align='center'>
<span title='5 / 19'>26%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u329-west-ham-utd' target='_top'>West Ham Utd</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
4.53</font></td>
<td align='center'><font color='#C70039'>
6.68</font></td>

<td>
<div style='width:44.84px;' class='bargray'></div>
</td>

<td align='left'><b>11.21</b></td>

<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='12 / 19'>63%</span></td>

</tr>
<tr class='odd' height='28'>
<td align='left' style='padding-left:5px;'>
<a href='teamstats.asp?league=england&stats=u336-wolverhampton' target='_top'>Wolverhampton</a>&nbsp;</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><font color='blue'>
3.68</font></td>
<td align='center'><font color='#C70039'>
6.53</font></td>

<td>
<div style='width:40.84px;' class='bargray'></div>
</td>

<td align='left'><b>10.21</b></td>

<td align='center'>
<span title='14 / 19'>74%</span></td>
<td align='center'>
<span title='13 / 19'>68%</span></td>
<td align='center'>
<span title='8 / 19'>42%</span></td>

</tr>

<tr><td colspan=10></td></tr>
<tr bgcolor='#e0e0e0' style='pointer-events:none;'><td height='25' colspan='2' style='padding-left:5px;'><b>
League average
</b></td>
<td colspan='4'></td>
<td align='center'>
66%
</td>
<td align='center'>
56%
</td>
<td align='center'>
44%
</td>
</tr>

</table>
</div>
</div>

	</td></tr>
	</table>






<p style='text-align:left;padding:10px 10px 10px 10px;font-size:14px;color:#666666;line-height:18px;'></p><p align='left' style='padding:10px 10px 10px 10px;'></p><p align='left' style='padding:10px 10px 10px 10px;font-size:15px;line-height:20px;'></p></td></tr></table>
            
	</div>
</div>


 
			



    
<!-- call to js files -->
<!-- <script src="https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js"></script> -->
<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>

<SCRIPT type="text/javascript">
function setCookie(cname, cvalue, exdays) {
    var d = new Date();
    d.setTime(d.getTime() + (exdays*24*60*60*1000));
    var expires = "expires="+d.toUTCString();
    document.cookie = cname + "=" + cvalue + "; " + expires;
}
</script>










	
	
		<br><br>
		<table width='100%' cellpadding='8' cellspacing='0' border='0'>
	

		<tr><td valign='middle' align='center' bgcolor='#ffffff'>
<br><br><br><br><h2>Tables overview</h2>
<table width='100%' cellspacing='1' cellpadding='6' border='0'>
<tr>
<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3>Points</h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Points'><font style='font-size:10px;color:#000000;'>pts</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
85
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
78
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
71
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
65
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
60
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
57
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
54
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
53
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
53
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
52
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
52
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
49
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
49
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
47
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
45
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
44
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
41
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
39
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
22
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>
</table>
</td>
<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3>Form (last 8)</h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Points'><font style='font-size:10px;color:#000000;'>pts</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
18
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
16
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
15
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
15
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
14
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
14
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
13
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
11
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
11
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
11
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
10
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
8
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
7
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
6
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
6
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
4
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
4
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
2
</b></td>
<td></td>
</tr>
</table>
</td>

<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3>Home</h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Points'><font style='font-size:10px;color:#000000;'>pts</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
47
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
45
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
42
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
38
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
36
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
35
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
33
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
33
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
32
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
32
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
32
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
31
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
23
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
22
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
21
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
15
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
14
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
13
</b></td>
<td></td>
</tr>
</table>
</td>
<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3>Away</h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Points'><font style='font-size:10px;color:#000000;'>pts</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
38
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
33
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
29
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
27
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
24
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
24
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
24
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
21
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
21
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
15
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
9
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
6
</b></td>
<td></td>
</tr>
</table>
</td>

<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3><font style='color:#0225A1;'>Offence</font></h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Goals scored'><font style='font-size:10px;color:#000000;'>GF</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
77
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
71
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
69
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
63
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
58
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
58
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
56
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
55
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
53
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
52
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
49
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
48
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
48
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
47
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
47
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
46
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
42
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
41
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
38
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
27
</b></td>
<td></td>
</tr>
</table>
</td>
<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3><font style='color:#C70039;'>Defence</font></h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Goals conceded'><font style='font-size:10px;color:#000000;'>GA</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
27
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
35
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
46
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
48
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
49
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
50
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
50
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
51
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
51
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
51
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
52
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
52
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
53
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
54
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
55
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
56
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
57
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
65
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
68
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>38</font></td>
<td align='center'><b>
75
</b></td>
<td></td>
</tr>
</table>
</td>
</tr></table>
<br>
<table width='100%' cellspacing='1' cellpadding='6' border='0'>
<tr>
<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3><font style='color:#0225A1;'>Offence (last 8)</font></h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Goals scored'><font style='font-size:10px;color:#000000;'>GF</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
16
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
15
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
14
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
14
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
13
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
13
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
12
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
12
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
12
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
10
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
10
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
9
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
8
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
8
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
7
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
6
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
5
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
5
</b></td>
<td></td>
</tr>
</table>
</td>
<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3><font style='color:#C70039;'>Defence (last 8)</font></h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Goals conceded'><font style='font-size:10px;color:#000000;'>GA</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
5
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
7
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
8
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
8
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
8
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
8
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
9
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
10
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
10
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
10
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
10
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
12
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
12
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
13
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
13
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
15
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
16
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
16
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>8</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>
</table>
</td>

<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3><font style='color:#0225A1;'>Offence (home)</font></h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Goals scored'><font style='font-size:10px;color:#000000;'>GF</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
45
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
41
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
39
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
36
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
34
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
33
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
32
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
30
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
30
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
29
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
29
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
27
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
25
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
22
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
19
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
19
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
18
</b></td>
<td></td>
</tr>
</table>
</td>
<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3><font style='color:#C70039;'>Defence (home)</font></h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Goals conceded'><font style='font-size:10px;color:#000000;'>GA</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
11
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
14
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
21
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
21
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
22
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
23
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
23
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
24
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
25
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
27
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
29
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
30
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
30
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
31
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
34
</b></td>
<td></td>
</tr>
</table>
</td>

<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3><font style='color:#0225A1;'>Offence (away)</font></h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Goals scored'><font style='font-size:10px;color:#000000;'>GF</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
32
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
32
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
30
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
30
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
29
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
29
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
28
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
24
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
22
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
22
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
22
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
21
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
20
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
19
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
17
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
8
</b></td>
<td></td>
</tr>
</table>
</td>
<td align='center' valign='middle' style='margin:6px;'>

<table border='0' cellpadding='2' cellspacing='0' width='100%' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr><td colspan='5' height='26' align='center' valign='middle'>
<h3><font style='color:#C70039;'>Defence (away)</font></h3>
</td></tr>
<tr>
<td colspan='2' height='22' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Matches played'><font style='font-size:10px;color:#000000;'>GP</font></span></td>
<td align='center' style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'><span title='Goals conceded'><font style='font-size:10px;color:#000000;'>GA</font></span></td>
<td style='border-top:1px solid #aaaaaa;border-bottom:1px solid #aaaaaa;'></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Arsenal</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
16
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester C.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
21
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Everton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
23
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Newcastle Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
25
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Tottenham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Manchester U.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brighton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
26
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Chelsea</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
27
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Aston Villa</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
27
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Sunderland</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
28
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Nottm Forest</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
28
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Crystal Pala.</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
28
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Fulham</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
31
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Brentford</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
31
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Liverpool</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
33
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Wolverhampton</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
34
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Bournemouth</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
34
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>West Ham Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
35
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Leeds Utd</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
35
</b></td>
<td></td>
</tr>

<tr height='22'>

<td align='center'></td>
<td style='text-align:left;font-size:13px;'>Burnley</td>
<td align='center'><font color='green'>19</font></td>
<td align='center'><b>
46
</b></td>
<td></td>
</tr>
</table>
</td>
</tr></table>
<br><br>		
			<br>
			<table width="100%" border="0" cellpadding="2" cellspacing="2" style="margin-top:40px;">
			<tr><td valign="top" align="center">
				<table width="100%" border="0" cellpadding="2" cellspacing="2">
				<tr bgcolor="#f0f0f0"><td align="center" valign="middle" height='28'>            
				<h3>Segments Table</h3></font>
				</td></tr>
				</table>		
				<table width="100%" border="0" cellspacing="2" style="padding-bottom:5px;">
				<tr><td valign="top" align="center">

<table width='100%' cellspacing='0' cellpadding='4'>
<tr><td align='left' valign='middle' width='100'><font style='color:green;font-size:24px;'><b>0 pt</b></font></td>
<td><img src='img/arrows/arrow_right_4.png' width='670' height='42' alt='Segments table progression arrow'></td>
<td align='center' valign='middle'><font style='color:green;font-size:24px;'><b>85 pts</b></font></td></tr>
</table>
<table width='100%' cellspacing='1' cellpadding='3' style='border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>
<tr bgcolor='#f8f8f8' height='26'>
<td width='20%' align='center'><font size='2' color='green'><b>5th</b></font> Segment</td>
<td width='20%' align='center'><font size='2' color='green'><b>4th</b></font> Segment</td>
<td width='20%' align='center'><font size='2' color='green'><b>3rd</b></font> Segment</td>
<td width='20%' align='center'><font size='2' color='green'><b>2nd</b></font> Segment</td>
<td width='20%' align='center'><font size='2' color='green'><b>1st</b></font> Segment</td>
</tr>
<tr bgcolor='#e0e0e0' height='26'>
<td align='center'><b>up to 16.6 pts</b></td>
<td align='center'><b>from 16.7 to 33.7 pts</b></td>
<td align='center'><b>from 33.8 to 50.8 pts</b></td>
<td align='center'><b>from 50.9 to 67.9 pts</b></td>
<td align='center'><b>from 68.0 to 85 pts</b></td>
</tr>
<tr bgcolor='#f8f8f8'>
<td style='vertical-align:top;line-height:16px;'>
</td>
<td style='vertical-align:top;line-height:16px;'>
<font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>22</b></font>&nbsp;

Burnley

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>20</b></font>&nbsp;

Wolverhampton

</td>
<td style='vertical-align:top;line-height:16px;'>
<font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>49</b></font>&nbsp;

Newcastle Utd

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>49</b></font>&nbsp;

Everton

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>47</b></font>&nbsp;

Leeds Utd

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>45</b></font>&nbsp;

Crystal Palace

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>44</b></font>&nbsp;

Nottm Forest

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>41</b></font>&nbsp;

Tottenham

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>39</b></font>&nbsp;

West Ham Utd

</td>
<td style='vertical-align:top;line-height:16px;'>
<font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>65</b></font>&nbsp;

Aston Villa

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>60</b></font>&nbsp;

Liverpool

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>57</b></font>&nbsp;

Bournemouth

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>54</b></font>&nbsp;

Sunderland

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>53</b></font>&nbsp;

Brighton

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>53</b></font>&nbsp;

Brentford

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>52</b></font>&nbsp;

Chelsea

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>52</b></font>&nbsp;

Fulham

</td>
<td style='vertical-align:top;line-height:16px;'>
<font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>85</b></font>&nbsp;

Arsenal

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>78</b></font>&nbsp;

Manchester City

<br><font color='green'>(38)</font>&nbsp;&nbsp;<font size='2'><b>71</b></font>&nbsp;

Manchester Utd

</td>
</tr>
</table>
			
				</td></tr>
				</table>				
<p style='text-align:left;font-size:15px;line-height:20px;padding-right:4px;padding-left:4px;'>The <b>Segments Table</b> is a visual representation splitting the teams into 5 segments. Each team is assigned to a specific segment, depending on the team's number of points. Each of the 5 segments spans one-fifth (20%) of the total points held by the team ranked 1st in the league. For each team, the number of matches played appears in green between brackets, and the number of points is displayed in black.</p><br><br><br><br>				
			</td></tr>
			</table>				

		</td></tr>




	

			<tr><td valign='middle' align='center' bgcolor='#ffffff'>
	
		</td></tr>
		</table>

	

		<br><br>
		<table width='97%' cellpadding='0' cellspacing='0' border='0' style='margin-left:14px;margin-riht:14px;border:1px solid #aaaaaa;border-radius:12px;overflow:hidden;'>		
		<tr><td valign='middle' align='center' bgcolor='#ffffff'>

<h2 style='color:#fafafa;text-align=center;background-color:#666666;height:20px;padding-top:6px;padding-bottom:0px;margin-top:0px;margin-left:0px;'>Premier League stats</h2>

<TABLE CELLSPACING='0' CELLPADDING='6' BORDER='0' width='100%'>
<tr class='trow3'>
<td valign='top' width='19%'>
<TABLE CELLSPACING='0' CELLPADDING='2' BORDER='0' width='180'>
<tr class='trow3'>
<td valign='middle' align='center' colspan='3' width='100%'>
<b>380</b> matches played / 380
</td></tr>
<tr class='trow3'>
<td align='right'><font style='font-size:11px;color:#666666;'></font></td>
<td height='25' width='113'>
<table  width='100%' cellspacing='0' cellpadding='0' width='100%' style='margin-left:1px;'>
<tr>
<td align='center'>
<progress value='100.00' max='100'></progress>
</td>
</tr></table>
</td>
<td><font style='font-size:11px;color:#666666;'></font></td>
</tr>
<tr class='trow3' height='14'>
<td valign='middle' align='center' colspan='3'><font size='1'>
100.0% completed
</font></td>
</tr>
</table>
</td>
<td valign='top' width='40%'>
<TABLE CELLSPACING='0' CELLPADDING='2' BORDER='0' width='100%'>
<tr class='trow3'>
<td height='20' width='90' align='right'>Home wins:&nbsp;</td>
<td width='35'><b>43%</b></td>
<td width='80'>
<div class='graphwideindex'><div style='width:22.21px;' class='bargreen'></div></div>
</td>
<td align='right' width='30%'>
Over 1.5 goals:&nbsp;
<td><b>79%</b>
</td>
</tr>
<tr class='trow3'>
<td align='right' height='20'>Draws:&nbsp;</td>
<td><b>27%</b></td>
<td width='60'>
<div class='graphwideindex'><div style='width:13.95px;' class='barorange'></div></div>
</td>
<td align='right'>
Over 2.5 goals:&nbsp;
<td><b>55%</b>
</td>
</tr>
<tr class='trow3'>
<td height='20' align='right'>Away wins:&nbsp;</td>
<td><b>30%</b></td>
<td width='60'>
<div class='graphwideindex'><div style='width:15.50px;' class='barred'></div></div>
</td>
<td align='right'>
Over 3.5 goals:&nbsp;
<td><b>28%</b>
</td>
</tr>
</table>
</td>
<td valign='top' width='41%'>
<TABLE CELLSPACING='0' CELLPADDING='2' BORDER='0' width='100%'>
<tr class='trow3'>
<td height='20' align='right'>
Goals:&nbsp;</td>
<td><b>1045</b></td>
<td align='right' colspan='2'>
Home goals per match:&nbsp;</td>
<td><b>1.53</b></td>
</tr>
<tr class='trow3'>
<td height='20' align='right'>
Goals per match:&nbsp;</td>
<td><font size='2' color='blue'><b>2.75</b></font></td>
<td height='20' align='right' colspan='2'>
Away goals per match:&nbsp;</td>
<td><b>1.22</b></td>
</tr>
<tr class='trow3'>
<td>&nbsp;</td>
<td>&nbsp;</td>
<td align='right' colspan='2'>
Both teams scored:&nbsp;</td>
<td><b>56%</b></td>
</tr>
</table>
</td>
</tr>
</table>

<TABLE CELLSPACING='0' CELLPADDING='8' BORDER='0' width='100%'>
<tr class='trow3'>
<td width='25%' valign='top' align='center'>
<h3 style='padding-bottom:6px;'>Results</h3>
<table id='btable'>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='latest.asp?league=england'>Latest results</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='results.asp?league=england&tid=a'>Matches by date</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='results.asp?league=england&pmtype=round98'>Matches by Matchweek</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=v'>Results grid</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='matchlist.asp?league=england&tid=v'>Results filter</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='round_details.asp?league=england&mrevid=m9999'>Outcome Surprise-Levels</a></td></tr>
</table>
</td>
<td width='25%' valign='top' align='center'>
<h3 style='padding-bottom:6px;'>Tables</h3>
<table id='btable'>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='homeaway.asp?league=england'>Home / Away tables</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='widetable.asp?league=england'>Wide table</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='statsbymonth.asp?league=england'>Tables by Date</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='formtable.asp?league=england'>Form tables</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='scorers.asp?league=england'>Scorers</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=cr'>Corner stats</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=pp'>Projected points</a></td></tr>
</table>
</td>
<td width='25%' valign='top' align='center'>
<h3 style='padding-bottom:6px;'>Analysis</h3>
<table id='btable'>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='trends.asp?league=england'>Goals statistics</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=rp'>Points performance</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=c'>Over / Under</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=f'>Scored / Conceded</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=ha'>Home advantage</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=re'>Relative form</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=10'>Run-in analysis</a></td></tr>
</table>
<br>
</td>
<td width='25%' valign='top' align='center'>
<h3 style='padding-bottom:6px;'>Goal times</h3>
<table id='btable'>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='timing.asp?league=england'>When goals were scored</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='halftime.asp?league=england'>1st-half / 2nd-half</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='firstgoal.asp?league=england'>First team to score</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=u'>Goal types</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=t'>Lead durations</a></td></tr>
<tr class='odd' height='26'><td>&nbsp;<a class='countrylist' href='table.asp?league=england&tid=pw'>Points Won/Lost</a></td></tr>
</table>
</td>
</tr>
</table>
<tr>
<td>
<TABLE CELLSPACING='0' CELLPADDING='2' BORDER='0' width='100%'>
<tr class='trow3'>
<td style='height:22px;text-align:right;'>Home team scored first: </td><td><b>55%</b></td>
<td style='height:22px;text-align:right;'>No goal scored: </td><td><b>7%</b></td>
<td style='height:22px;text-align:right;'>Away team scored first: </td><td><b>38%</b></td>
</tr>
<tr class='trow3'>
<td style='height:22px;text-align:right;'>Average minute when home team scored first: </td><td><b>31 min.</b> </td>
<td style='height:22px;text-align:right;'></td><td></td>
<td style='height:22px;text-align:right;'>Average minute when away team scored first: </td><td><b>34 min.</b></td>
</tr>
<tr class='trow3'>
<td style='height:22px;text-align:right;'>Home team lead-defending rate: </td><td><font color='blue'><b>58%</b></font></td>
<td style='height:22px;text-align:right;'></td><td></td>
<td style='height:22px;text-align:right;'>Away team lead-defending rate: </td><td><font color='blue'><b>56%</b></font></td>
</tr>
<tr class='trow3'>
<td style='height:22px;text-align:right;'>Home team equalizing rate: </td><td><font color='blue'><b>44%</b></font></td>
<td style='height:22px;text-align:right;'></td><td></td>
<td style='height:22px;text-align:right;'>Away team equalizing rate: </td><td><font color='blue'><b>42%</b></font></td>
</tr>
<tr class='trow3'>
<td style='height:22px;text-align:right;'>Home team lead duration: </td><td><b>30%</b></td>
<td style='height:22px;text-align:right;'>Teams level in goals: </td><td><b>50%</b></td>
<td style='height:22px;text-align:right;'>Away team lead duration: </td><td><b>20%</b></td>
</tr>
<tr class='trow3'>
<td style='height:22px;text-align:right;'>Home PPG when home team scored first: </td><td><font color='blue'><b>2.23</b></font></td>
<td style='height:22px;text-align:right;'></td><td></td>
<td style='height:22px;text-align:right;'>Away PPG when away team scored first: </td><td><font color='blue'><b>2.09</b></font></td>
</tr>
</TABLE>
</td>
</tr>
</table>
</tr>
</table>
<br>
<table width='100%' cellspacing='0' cellpadding='2' border='0' style='padding-left:12px;padding-right:12px;'>
<tr><td style='text-align:left;line-height:20px;font-size:15px;'>
More statistics tables can be accessed from the 'Statistics' dropdown list on the league navigation menu.
<br>
</td></tr></table>
							
			<table width='100%' cellspacing='0' cellpadding='2' border='0' style='padding-left:8px;padding-right:8px;margin-top:10px;padding-left:12px;padding-right:12px;'>
			<tr><td align="left" style="line-height:16px;"><font style="font-size:13px;">
			The number of matches included in the regular season may differ depending on the way each league is structured. For most national leagues, 
			the stats above relate to the selected league competition in the regular season, excluding playoff matches. Some leagues include additional rounds of matches, for which dedicated 
			group tables may be featured on this page. When such group tables are displayed on the main league page, the stats above also include the matches related to those tables.  
			</font>
			</td></tr>
			</table>			
			<br><br>
		</td></tr>	
		</table>








</div>


































<!-- Global site tag (gtag.js) - Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=UA-156655133-1"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'UA-156655133-1', { 'anonymize_ip': true });
</script>
















<!-- Default Statcounter code for SoccerSTATS.com (legacy)
https://soccerstats.com -->
<script type="text/javascript">
var sc_project=2749989; 
var sc_invisible=1; 
var sc_security="80356660"; 
</script>
<script type="text/javascript"
src="https://www.statcounter.com/counter/counter.js"
async></script>
<noscript><div class="statcounter"><a title="Web Analytics"
href="https://statcounter.com/" target="_blank"><img
class="statcounter"
src="https://c.statcounter.com/2749989/0/80356660/1/"
alt="Web Analytics"
referrerPolicy="no-referrer-when-downgrade"></a></div></noscript>
<!-- End of Statcounter Code -->



<script type="text/javascript">
function parseJSAtOnload() {
var links = ["js/summaries_leaguesearchjs.js","js/summaries_searchteams.js","js/richhtmlticker.js"],
headElement = document.getElementsByTagName("head")[0],
linkElement, i;

var urlParamsJS = 'england';


var options = [
 {value:'Both teams scored', data:'table.asp?league=' + urlParamsJS + '&tid=p'},
 {value:'Clean sheets', data:'table.asp?league=' + urlParamsJS + '&tid=y'},

{value:'Corner stats', data:'table.asp?league=' + urlParamsJS + '&tid=cr'},



 {value:'Current streaks', data:'table.asp?league=' + urlParamsJS + '&tid=g'},



{value:'Equalisers conceded', data:'table.asp?league=' + urlParamsJS + '&tid=w'},
{value:'Equalisers scored', data:'table.asp?league=' + urlParamsJS + '&tid=x'},



{value:'Failed to score', data:'table.asp?league=' + urlParamsJS + '&tid=z'},



{value:'First / second half tables', data:'table.asp?league=' + urlParamsJS + '&tid=s1'},
{value:'First / second half Home tables', data:'table.asp?league=' + urlParamsJS + '&tid=s2'},
{value:'First / second half Away tables', data:'table.asp?league=' + urlParamsJS + '&tid=s3'},
{value:'First goal stats', data:'firstgoal.asp?league=' + urlParamsJS},



 {value:'Form tables', data:'formtable.asp?league=' + urlParamsJS},




 {value:'Goals in each half', data:'table.asp?league=' + urlParamsJS + '&tid=6'},


 {value:'Goal margins', data:'table.asp?league=' + urlParamsJS + '&tid=e'},
 {value:'Goals per match (average goals)', data:'table.asp?league=' + urlParamsJS + '&tid=d'},




 {value:'Goals per 10-minute segments', data:'table.asp?league=' + urlParamsJS + '&tid=j'},
 {value:'Goals per 15-minute segments', data:'table.asp?league=' + urlParamsJS + '&tid=k'},
 {value:'Goal timing analysis', data:'timing.asp?league=' + urlParamsJS},
 {value:'Goal types', data:'table.asp?league=' + urlParamsJS + '&tid=u'},
 {value:'Half-time stats', data:'halftime.asp?league=' + urlParamsJS},


 {value:'Home advantage', data:'table.asp?league=' + urlParamsJS + '&tid=ha'},
 {value:'Home table / Away table', data:'homeaway.asp?league=' + urlParamsJS},





 {value:'HT/FT at home', data:'table.asp?league=' + urlParamsJS + '&tid=n'},
 {value:'HT/FT away', data:'table.asp?league=' + urlParamsJS + '&tid=o'},
 {value:'Lead durations', data:'table.asp?league=' + urlParamsJS + '&tid=t'},



 {value:'Matches by date', data:'results.asp?league=' + urlParamsJS},
 {value:'Matches by gameweek', data:'results.asp?league=' + urlParamsJS + '&pmtype=round98'},
 {value:'Match outcomes per team', data:'table.asp?league=' + urlParamsJS + '&tid=s8'},
 {value:'Outcome Suprise-Levels', data:'round_details.asp?league=' + urlParamsJS + '&mrevid=m9999'},
 {value:'Over / Under stats', data:'trends.asp?league=' + urlParamsJS},



 {value:'Over / under stats First-Half', data:'table.asp?league=' + urlParamsJS + '&tid=s4'},
 {value:'Over / under stats Second-Half', data:'table.asp?league=' + urlParamsJS + '&tid=s5'},
 {value:'Points Won / Points Lost', data:'table.asp?league=' + urlParamsJS + '&tid=pw'},



 {value:'Projected points', data:'table.asp?league=' + urlParamsJS + '&tid=pp'},
 {value:'Relative Performance', data:'table.asp?league=' + urlParamsJS + '&tid=rp'},
 {value:'Relative Form', data:'table.asp?league=' + urlParamsJS + '&tid=re'},
 {value:'Results filter', data:'matchlist.asp?league=' + urlParamsJS},
 {value:'Result matrix', data:'table.asp?league=' + urlParamsJS + '&tid=v'},
 {value:'Run-in analysis', data:'table.asp?league=' + urlParamsJS + '&tid=10'},
 {value:'Segments table', data:'table.asp?league=' + urlParamsJS + '&tid=2p'},




 {value:'Scored first stats', data:'table.asp?league=' + urlParamsJS + '&tid=2'},
 {value:'Conceded First stats', data:'table.asp?league=' + urlParamsJS + '&tid=3'},
 {value:'Scored or Conceded First stats', data:'table.asp?league=' + urlParamsJS + '&tid=s6'},
 {value:'Scored / conceded at Half-Time', data:'table.asp?league=' + urlParamsJS + '&tid=s7'},
 {value:'Scored in both halves', data:'table.asp?league=' + urlParamsJS + '&tid=pa'},
 {value:'Table when Leading at Half-Time', data:'table.asp?league=' + urlParamsJS + '&tid=h'},
 {value:'Table when Losing at Half-Time', data:'table.asp?league=' + urlParamsJS + '&tid=i'},
 {value:'Table when team scored first', data:'table.asp?league=' + urlParamsJS + '&tid=l'},
 {value:'Table when opponent scored first', data:'table.asp?league=' + urlParamsJS + '&tid=m'},


 {value:'Table generator by date', data:'statsbymonth.asp?league=' + urlParamsJS},


 {value:'Top scorers', data:'scorers.asp?league=' + urlParamsJS},



 {value:'Total goals (exact number)', data:'table.asp?league=' + urlParamsJS + '&tid=8'},
 {value:'Total goals (goal ranges)', data:'table.asp?league=' + urlParamsJS + '&tid=9'},
 {value:'Total goals (scored / conceded)', data:'table.asp?league=' + urlParamsJS + '&tid=f'},
 {value:'Wide table', data:'widetable.asp?league=' + urlParamsJS}

];
$('#autocomplete3').autocomplete({
lookup: options,
onSelect: function (suggestion) {
}
});
$('#autocomplete3').autocomplete({
lookup: options,
onSelect: function (suggestion) {
location.href=suggestion.data
}
});



for (i = 0; i < links.length; i++) {
linkElement = document.createElement("script");
linkElement.src = links[i];
headElement.appendChild(linkElement);
}
}
if (window.addEventListener)
window.addEventListener("load", parseJSAtOnload, false);
else if (window.attachEvent)
window.attachEvent("onload", parseJSAtOnload);
else window.onload = parseJSAtOnload;
</script>  



<script>
function init() {
var vidDefer = document.getElementsByTagName('iframe');
for (var i=0; i<vidDefer.length; i++) {
if(vidDefer[i].getAttribute('data-src')) {
vidDefer[i].setAttribute('src',vidDefer[i].getAttribute('data-src'));
} } }
window.onload = init;
</script>










<div style="clear:both;"></div>










<link rel="stylesheet" type="text/css" href="css/sshpstyle_03.css?v=1.909">





















</div>		
	
		<div class="sidebar3" style="float:left;height:3000px;min-width:310px;background-color:#e8e8e8;margin-left:10px;">

		</div>
</div><div id='bottomdiv' style='background-color:#e8e8e8;height:display: flex;justify-content: center;'><table><tr height='6'><td>&nbsp;</td></tr></table>















	


<table border="0" cellspacing="0" cellpadding="2" width="100%">
<tr bgcolor='#dddddd'>
<td align='left' valign='middle' colspan='2' style='font-size:14px;padding-top:16px;padding-bottom:16px;padding-left:4px;padding-right:4px;line-height:16px;padding-left:12px;padding-right:12px;'>
<table style='width:100%;border-top:1px solid #cccccc;margin-top:30px;margin-bottom:10px;'><tr><td></td></tr></table>SoccerSTATS.com provides football statistics, results and blog articles on national and international soccer competitions worldwide. Football fans can keep a tab on stats related to their favourite team or leagues of interest, and access a wide range of team performance data analytics and league standings, not only on the world's most famous professional leagues, but also on amateur and regional leagues over the world. Example of soccer statistics include league standings, form tables, top goal scorers, scoring stats, statistical previews and goal timing statistics. 
</td>
</tr>





<p style='margin-top:26px;padding-top:16px;padding-left:16px;font-size:13px;color:#222222;text-align:left;'>SoccerSTATS.com - Public edition</p>













<tr bgcolor='#dddddd'>

<td align='left' colspan='4' style='padding:10px;'>




<table width='150' cellpadding='2' cellspacing='0' style='padding-top:8px;padding:2px;'>
<tr>
<td width='150' height='24' align='center' valign='middle' onclick="window.open('https://www.twitter.com/soccerstatscom','_blank','noopener');" bgcolor='#0066b2' style="font-family:arial;font-size:14px;padding-left:2px;cursor:hand;cursor:pointer;"  onMouseOver="this.style.background='#1dcaff'" onMouseOut="this.style.background='#0066b2'">
<font color='white'>Follow us on Twitter</font>
</td>
</tr>
</table>







<table width="100%" cellpadding="2" cellspacing="0" border="0" style="padding-top:7px;">



<tr>
<td width="25%"><a href="//www.soccerstats.com/faq.asp" target="_top" rel="nofollow"><font color='black'>F.A.Q.</font></a></td>
<td width="25%"><a href="//www.soccerstats.com/contact.asp" target="_top" rel="nofollow"><font color='black'>Contact</font></a></td>

<td width="25%"><a href="//www.soccerstats.com/legal.asp" target="_top" rel="nofollow"><font color='black'>Privacy Policy</font></a></td>
<td width="25%">

<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3910539363731532" crossorigin="anonymous"></script>

			<!-- <a class="change-consent" onclick="window.__tcfapi('displayConsentUi', 2, function() {} );" rel="noindex, nofollow">Change consent</a> -->
			<!--  <a class="hover:underline" href="#" onclick="__cmp('showScreen'); return false">Change consent</a> -->

<a href="javascript:void(0)" onclick="(function(){
  // 1. Identify which mode is ACTIVE (not just present)
  // InMobi sets gdprApplies to true only when in Europe
  window.__tcfapi('ping', 2, function(pingData) {
    if (pingData.gdprApplies) {
      // PERSONA: EUROPE
      window.__tcfapi('displayConsentUi', 2, function(){});
    } else {
      // PERSONA: US / GLOBAL
      if (window.__uspapi) {
        window.__uspapi('displayUspUi');
      } else if (window.__gpp) {
        window.__gpp('displayConsentUi', function(){}, 7);
      }
    }
  });
  return false;
})()">Privacy Settings</a>









</td>
</tr>





<tr>
<td width="25%"><a href="//www.soccerstats.com/legal.asp#terms" target="_top" rel="nofollow"><font color="black">Terms & conditions of use</font></a></td>
<td width="25%"><a href="//www.soccerstats.com/aboutus.asp" target="_top" rel="nofollow"><font color="black">About us</font></a></td>

<td width="25%"><a href="//www.soccerstats.com/legal.asp#cookies" target="_top" rel="nofollow"><font color="black">Cookie usage and options</font></a></td>
<td width="25%">

</td>
</tr>





<tr>

<td width="25%">

<a href="//www.soccerstats.com/installpwa.asp" target="_top" rel="nofollow"><font color="black">Mobile app</font></a>

</td>

<td width="25%">
</td>



<td width="25%"></td>

<td width="25%"></td>

</tr>






</table>
<br>



</td>










</tr>

<tr bgcolor='#dddddd'>
<td colspan='4' style='padding-left:10px;padding-right:10px;'>    
    <table cellspacing="0" cellpadding="0" border="0" width="100%">
    <tr>
    <td valign="middle" style="line-height:16px;"><font color='#222222'>
    Please note that match schedules and timing are subject to changes. Products, services, promotional offers and other offerings from partners and advertisers are subject to terms and conditions. 
    
	By using this website you certify that you agree with the <a href='legal.asp#terms'><font color='#222222'><u>terms and conditions of use</u></font></a> and the <a href='legal.asp'><font color='#222222'><u>privacy policy</u></font></a> and that you are over the age of 18 or that you have the permission of a parent or guardian to use this website, after your parent or guardian has carefully reviewed and agreed to the <a href='legal.asp#terms'><font color='#222222'><u>terms and conditions of use</u></font></a> and the <a href='legal.asp'><font color='#222222'><u>privacy policy</u></font></a>.
	
	The website's content is provided for informational purposes only is not to be relied upon as a professional opinion whatsover. Nothing on this website should be considered as advice. 

	This website is not associated with nor endorsed by any league or competition (whether professional, collegiate or other types of leagues / competitions), federation, association, club or team.
	
	All trademarks, brands, images, logos and names appearing on this website belong to their respective owners.  
	<br>
     Useful links (third-party websites):  &nbsp;
	 
    <a href="https://www.gamcare.org.uk" target="_blank" class="blacklink" rel="nofollow noopener noreferrer">www.gamcare.org.uk</a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
	<a href="https://www.begambleaware.org" target="_blank" class="blacklink" rel="nofollow noopener noreferrer">www.begambleaware.org</a>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;	 
	<a href="https://www.gamblingtherapy.org" target="_blank" class="blacklink" rel="nofollow noopener noreferrer">gamblingtherapy.org</a>

	</font>
    </td>
    </tr>
    </table>
	 

	</td></tr>

	<tr bgcolor='#dddddd'><td align='left' colspan='4'>&nbsp;&nbsp;&nbsp;</td></tr>
	<tr bgcolor='#666666' height='28'><td colspan='4' style="line-height:16px;">		
	
	<table style="width:100%;padding-left:8px;padding-right:8px;"><tr height="35">
	<td><font color="white">Copyright 1998-2026 SoccerSTATS.com</font></td>	
<td style='text-align:right;padding-right:8px;color:#f0f0f0;'>	
<!--
	<font color="#f0f0f0">We are based in the Netherlands and the EU's GDPR rules apply to our website's <a style="color:#f0f0f0;text-decoration:underline;" href="legal.asp" rel="nofollow">privacy policy</a></font>
-->	
	</td>
	</tr></table>



</td>
</tr>
</table>

	 
<!-- Back to top button (left)
<a href="#" title="Back to top" style="position: fixed; bottom:230px;left:3px;font-size: 14px;font-weight: bold;z-index: 99;">
<img width="32" height="32" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAABhlBMVEUAAAAHFiAHGCMIGSUHFyEIGSUJHisKIjEIGSUJHCgNKTwOKz8TOFEUPFcUPVgVQFwWQV4XRWMRNU0SOVMZSmoaTG4bTnETPloUP1sZTnEaTG0aUncbUHQbUXQWRmUYSmskapkka5olbp8ZTnEaUncdVXoeWYEeWoEcVHkeWIAaT3IbU3geXYceYIoodqopea8cWYEcWoIhZ5UhaZcjb6EkcqQtg70uhsEuh8Miapoia5oldKgldaowjs0xj88xkNAkcqUmd60mea8ofLMpfrYpgbopgbs0mNspgLkpgLk0mNsvjcs0mNs0mNsshsI0mNspgLkqgrwqg74rhL8rhcEshsIsh8MsiMQsiMUuisgvh8Evjcsvjswwj84wkNAxktMylNYyldczltgzl9o0mNs2mds8nNw+jL9AjsJFnNVHod1XqN9ioclppctqsuFtqM5vst5xteKCveSGtdOSvNeVxeSdyue11eq/1uTI3+zL3efY5u7d5+zj6+/m7O/p7vDr7/Ds8PFqLrIUAAAAUHRSTlMAAQEBAgICAgMDDg4XFxcYGBgmJiYmJjIyPj4+Pj5GRkZGRklJUVFRUlJTU1lZW1tsbHl5h4eLi4uTk5iYoqKipqioqanOztzf6evv+/z9/nih35EAAAGYSURBVDjLrZNXVwIxEIVV7L333rD3gh0rImVBYQEVRRKKUgQEscP8cyHJ7iKsD57jPfuQmfttkkkmRUX/q7recWVf/W9u27qGwxlxGlW7jN24a8CiDHtN+f7QGf6hs+Gf/pwe50k/n+sPFvgZImeOBmn+WExaRdrHjpgMp1JhMdgT/FZx/4FPgM+AWItQ7ZqQeXiHjN4fhFjFAA2Lva9A9OplCQ31azkaepIAb+RLemiGo6fezfhngJdHgMcXgGeW6iPAGCsQ4MMfAYj4PwBYsUoCTLACIR28iQJEb4JpYMVOEmCKjBNfEHfgLIAdcfhKkOQ0AfpRdsz7ni4RBdDlk4/P5tAAAZpdJLi+uMMUwHcX1+QnVwsBynXSDVFAkK6CHsQhkgfQETvJEac84BxlQPGxWw5wnyiE6+wyokIAGXukjlmxM+I+FLpnvn01p+VK9610lVub7ZbObz0oy23Kyi2zU6oFI6d5uyqv72e051cuwiDX1bl2tvDlVC+dmswWnreYTafLNbJvr6RjYUOt3lzsVPzlPX8DFUDvMylY+zgAAAAASUVORK5CYII=" alt="back to top"></a>
 -->
	 


<!-- Back to top button (right) -->
<a href="#" title="Back to top" style="position: fixed; bottom:230px;right:5px;font-size: 14px;font-weight: bold;z-index: 99;">
<img width="32" height="32" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAABhlBMVEUAAAAHFiAHGCMIGSUHFyEIGSUJHisKIjEIGSUJHCgNKTwOKz8TOFEUPFcUPVgVQFwWQV4XRWMRNU0SOVMZSmoaTG4bTnETPloUP1sZTnEaTG0aUncbUHQbUXQWRmUYSmskapkka5olbp8ZTnEaUncdVXoeWYEeWoEcVHkeWIAaT3IbU3geXYceYIoodqopea8cWYEcWoIhZ5UhaZcjb6EkcqQtg70uhsEuh8Miapoia5oldKgldaowjs0xj88xkNAkcqUmd60mea8ofLMpfrYpgbopgbs0mNspgLkpgLk0mNsvjcs0mNs0mNsshsI0mNspgLkqgrwqg74rhL8rhcEshsIsh8MsiMQsiMUuisgvh8Evjcsvjswwj84wkNAxktMylNYyldczltgzl9o0mNs2mds8nNw+jL9AjsJFnNVHod1XqN9ioclppctqsuFtqM5vst5xteKCveSGtdOSvNeVxeSdyue11eq/1uTI3+zL3efY5u7d5+zj6+/m7O/p7vDr7/Ds8PFqLrIUAAAAUHRSTlMAAQEBAgICAgMDDg4XFxcYGBgmJiYmJjIyPj4+Pj5GRkZGRklJUVFRUlJTU1lZW1tsbHl5h4eLi4uTk5iYoqKipqioqanOztzf6evv+/z9/nih35EAAAGYSURBVDjLrZNXVwIxEIVV7L333rD3gh0rImVBYQEVRRKKUgQEscP8cyHJ7iKsD57jPfuQmfttkkkmRUX/q7recWVf/W9u27qGwxlxGlW7jN24a8CiDHtN+f7QGf6hs+Gf/pwe50k/n+sPFvgZImeOBmn+WExaRdrHjpgMp1JhMdgT/FZx/4FPgM+AWItQ7ZqQeXiHjN4fhFjFAA2Lva9A9OplCQ31azkaepIAb+RLemiGo6fezfhngJdHgMcXgGeW6iPAGCsQ4MMfAYj4PwBYsUoCTLACIR28iQJEb4JpYMVOEmCKjBNfEHfgLIAdcfhKkOQ0AfpRdsz7ni4RBdDlk4/P5tAAAZpdJLi+uMMUwHcX1+QnVwsBynXSDVFAkK6CHsQhkgfQETvJEac84BxlQPGxWw5wnyiE6+wyokIAGXukjlmxM+I+FLpnvn01p+VK9610lVub7ZbObz0oy23Kyi2zU6oFI6d5uyqv72e051cuwiDX1bl2tvDlVC+dmswWnreYTafLNbJvr6RjYUOt3lzsVPzlPX8DFUDvMylY+zgAAAAASUVORK5CYII=" alt="back to top"></a>





	</div>
















<script>(function(){function c(){var b=a.contentDocument||a.contentWindow.document;if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:'a1c340173f89d476',t:'MTc4NDIyODQzMg=='};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;a.style.position='absolute';a.style.top=0;a.style.left=0;a.style.border='none';a.style.visibility='hidden';document.body.appendChild(a);if('loading'!==document.readyState)c();else if(window.addEventListener)document.addEventListener('DOMContentLoaded',c);else{var e=document.onreadystatechange||function(){};document.onreadystatechange=function(b){e(b);'loading'!==document.readyState&&(document.onreadystatechange=e,c())}}}})();</script></body>
</html>










<script type="text/javascript" src="js/tabber-top5.js"></script>

<!--
<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery.devbridge-autocomplete/1.4.1/jquery.autocomplete.min.js"></script>
-->



<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery.devbridge-autocomplete/1.2.27/jquery.autocomplete.min.js"></script>



<!--
<script type="text/javascript" src="js/summaries_leaguesearchjs.js"></script>
-->








<script>
   if(self == top) {
       document.documentElement.style.display = 'block'; 
   } else {
       top.location = self.location; 
   }
</script>


