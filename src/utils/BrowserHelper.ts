import getXPath from "get-xpath";
import {createNamedLogger} from "./shared_logging_setup";
import {DomWrapper} from "./DomWrapper";
import log, {Logger} from "loglevel";
import * as fuzz from "fuzzball";
import {
    ElementData,
    HTMLElementWithDocumentHost,
    isDocument,
    isHtmlElement,
    isIframeElement,
    isInputElement,
    isShadowRoot,
    maybeUpperCase,
    renderUnknownValue,
    SerializableElementData,
} from "./misc";
import {IframeNode, IframeTree} from "./IframeTree";
import {ElementHighlighter} from "./ElementHighlighter";

export function makeElementDataSerializable(elementData: ElementData): SerializableElementData {
    const serializableElementData: SerializableElementData = {...elementData};
    if ('element' in serializableElementData) {
        delete serializableElementData.element;
    }//ugly, but avoids forgetting to add another copying here if serializable fields are added to ElementData
    return serializableElementData;
}

//todo consider renaming this to HtmlHelper or HtmlElementHelper if I create a ChromeHelper class for accessing
// browser api's
export class BrowserHelper {

    //for dependency injection in unit tests
    private domHelper: DomWrapper;

    readonly logger: Logger;
    private elementHighlighter: ElementHighlighter;

    private cachedIframeTree: IframeTree | undefined;
    private cachedShadowRootHostChildrenOfMainDoc: HTMLElement[] | undefined;
    private existingMouseMovementListeners: Map<Document, (e: MouseEvent) => void> = new Map();

    constructor(domHelper?: DomWrapper, loggerToUse?: log.Logger, elementHighlighter?: ElementHighlighter) {
        this.domHelper = domHelper ?? new DomWrapper(window);

        this.logger = loggerToUse ?? createNamedLogger('browser-helper', false);
        this.elementHighlighter = elementHighlighter ?? new ElementHighlighter(this.fetchAndCacheIframeTree.bind(this));
    }

    fetchAndCacheIframeTree = (): IframeTree => {
        if (!this.cachedIframeTree) {this.cachedIframeTree = new IframeTree(this.domHelper.window as Window);}
        return this.cachedIframeTree;
    }

    resetElementAnalysis() {
        this.cachedIframeTree = undefined;
        if (this.cachedShadowRootHostChildrenOfMainDoc !== undefined) {
            this.logger.debug(`clearing cached list of children of main document which are hosts of shadow roots; that list had ${this.cachedShadowRootHostChildrenOfMainDoc.length} elements`);
            this.cachedShadowRootHostChildrenOfMainDoc = undefined;
        }
    }

    initializeCacheOfShadowRootHostChildrenOfMainDoc = (): HTMLElement[] => {
        this.logger.debug("initializing cache of children of main document which are hosts of shadow roots");
        const childrenOfMainDocumentWhichHostShadowRoots = this.domHelper.fetchElementsByCss('*')
            .filter(elem => elem.shadowRoot !== null);
        this.logger.debug(`found ${childrenOfMainDocumentWhichHostShadowRoots.length} elements which are hosts of shadow roots`);
        return childrenOfMainDocumentWhichHostShadowRoots;
    }

    /**
     * @description Gets the text content of an element, or the value of an input or textarea element
     * @param elementToActOn the element whose text or value is to be retrieved
     * @return the text content of the element, or the value of an input or textarea element
     */
    getElementText = (elementToActOn: HTMLElement): string | null => {
        let priorElementText = elementToActOn.textContent;
        if (('value' in elementToActOn && typeof (elementToActOn.value) === 'string')) {
            priorElementText = elementToActOn.value as string | null;
        }
        return priorElementText;
    }

    /**
     * @description Select an option from a select element, based on the option's name or an approximation of it
     * @param selectElement the select element to select an option from
     * @param optionName the name (or an approximation of the name) of the option element to select
     * @return the name/innertext of the option element which was selected
     */
    selectOption = (selectElement: HTMLElement, optionName: string): string | undefined => {
        let bestOptIndex = -1;
        let bestOptVal = undefined;//in case it's important, for some <select>, to be able to choose an option whose innertext is the empty string
        let bestOptSimilarity = -1;
        //todo idea for later- we might want to initialize bestOptSimilarity at some value above 0 (e.g. 0.3), to avoid
        // selecting an option with negligible similarity to the requested option name in a scenario where the AI got
        // really confused and gave a completely wrong value for the chosen select element?
        // confer with Boyuan; & should check what the similarity values look like in practice for good vs bad elements

        const selectElem = selectElement as HTMLSelectElement;

        console.time("timeFor_selectOptionFuzzyStringCompares");
        for (let optIndex = 0; optIndex < selectElem.options.length; optIndex++) {
            this.logger.trace("Comparing option #" + optIndex + " against " + optionName);
            const currOptVal = this.domHelper.getInnerText(selectElem.options[optIndex]);
            const similarity = fuzz.ratio(optionName, currOptVal);
            if (similarity > bestOptSimilarity) {
                this.logger.debug(`For requested option name ${optionName}, found better option ${currOptVal} with similarity ${similarity} at index ${optIndex}, beating prior best option ${bestOptVal} with similarity ${bestOptSimilarity} at index ${bestOptIndex}`);
                bestOptIndex = optIndex;
                bestOptVal = currOptVal;
                bestOptSimilarity = similarity;
            }
        }
        console.timeEnd("timeFor_selectOptionFuzzyStringCompares");
        selectElem.selectedIndex = bestOptIndex;
        this.logger.trace("sending change event to select element");
        selectElem.dispatchEvent(new Event('input', {bubbles: true}));
        selectElem.dispatchEvent(new Event('change', {bubbles: true}));

        return bestOptVal;
    }


    /**
     * @description converts line breaks to spaces and collapse multiple consecutive whitespace characters into a single space
     * This handles carriage-returns in addition to line feeds, unlike remove_extra_eol from browser_helper.py
     * @param text the text to process
     * @return string without any newlines or consecutive whitespace characters
     */
    removeEolAndCollapseWhitespace = (text: string): string => {
        return text.replace(/[\r\n]/g, " ").replace(/\s{2,}/g, " ");
    }

    /**
     * @description Get up to 8 whitespace-separated segments of the first line of a multi-line text
     * @param text the text to process, possibly containing line breaks
     * @return up to 8 whitespace-separated segments of the first line of the text
     */
    getFirstLine = (text: string): string => {
        const firstLine = text.split(/[\r\n]/, 1)[0];
        const firstLineSegments = firstLine.split(/\s+/);
        if (firstLineSegments.length <= 8) {
            return firstLine;
        } else {
            return firstLineSegments.slice(0, 8).join(" ") + "...";
        }
    }

    /**
     * @description Get a one-line description of an element, with special logic for certain types of elements
     * and some ability to fall back on information from parent element or first child element
     * @param element the element to describe
     * @return a one-line description of the element
     */
    getElementDescription = (element: HTMLElement): string | null => {
        const tagName = element.tagName.toLowerCase();
        const roleValue = element.getAttribute("role");
        const typeValue = element.getAttribute("type");

        const salientAttributes = ["alt", "aria-describedby", "aria-label", "aria-role", "input-checked",
            "label", "name", "option_selected", "placeholder", "readonly", "text-value", "title", "value",
            "aria-keyshortcuts"];

        let parentValue = "";
        const parent = this.getRealParentElement(element);
        //it's awkward that this 'first line' sometimes includes the innerText of elements below the main element (shown in a test case)
        // could get around that with parent.textContent and removing up to 1 linefeed at the start of it, for the
        // scenario where a label was the first child and there was a linefeed before the label element's text
        let parentText = parent ? this.domHelper.getInnerText(parent) : "";
        //todo remove this once I figure out what went wrong here a couple times
        if (parentText === undefined || parentText === null) {
            this.logger.error(`parent text was null or undefined for element ${parent?.outerHTML.slice(0, 300)}`);
            parentText = "";
        }
        const parentFirstLine = this.removeEolAndCollapseWhitespace(this.getFirstLine(parentText)).trim();
        if (parentFirstLine) {
            parentValue = "parent_node: [<" + parentFirstLine + ">] ";
        }

        if (tagName === "select") {
            const selectElement = element as HTMLSelectElement;
            //note that this doesn't necessarily give full picture for multi-select elements, room for improvement
            const selectedOptionText = selectElement.options[selectElement.selectedIndex]?.textContent;
            //this currently rules out the ability to support <select> elements which initially have no selected option
            // but that's a rare edge case; could be improved in future
            if (selectedOptionText) {
                let optionsText = Array.from(selectElement.options).map(option => option.text).join(" | ");

                //todo I don't understand how textContent would be non-empty when there were no options elements under
                // a select; There's the react-select library that could be used to create a select sort of element
                // with no <option> elements, but then the main element's tag wouldn't be <select>
                if (!optionsText) {
                    optionsText = selectElement.textContent ?? "";
                    //todo I can't figure out how you'd get a situation where textContent is empty but innerText is not
                    if (!optionsText) {
                        optionsText = this.domHelper.getInnerText(selectElement);
                    }
                }
                //why no use of removeEolAndCollapseWhitespace on optionsText??
                return parentValue + "Selected Options: " + this.removeEolAndCollapseWhitespace(selectedOptionText.trim())
                    + " - Options: " + optionsText;
            } else {
                this.logger.info("ELEMENT DESCRIPTION PROBLEM- No selected option found for select element (or selected option's text was empty string), processing it as a generic element");
            }
        }

        let inputValue = "";

        const typesForNoTextInputElements = ["submit", "reset", "checkbox", "radio", "button", "file"];
        if ((tagName === "input" || tagName === "textarea") && !typesForNoTextInputElements.includes(typeValue ?? "")
            && !typesForNoTextInputElements.includes(roleValue ?? "")) {
            const inputElement = element as HTMLInputElement;
            inputValue = `INPUT_VALUE="${inputElement.value}" `;
        }

        let elementText = (element.textContent ?? "").trim();
        if (elementText) {
            elementText = this.removeEolAndCollapseWhitespace(elementText);
            if (elementText.length > 80) {
                const innerText = (this.domHelper.getInnerText(element) ?? "").trim();
                if (innerText) {
                    return inputValue + this.removeEolAndCollapseWhitespace(innerText);
                } else {
                    //why are we completely skipping textContent if it's too long and innerText is empty? why not just truncate it?
                    this.logger.info("ELEMENT DESCRIPTION PROBLEM- Element text is too long and innerText is empty, processing it as a generic element");
                }
            } else {
                //possible improvement by including parentValue, but that would by default lead to duplication
                // if the parent's innerText was just this element's text, maybe add a check for that;
                // that concern would be made irrelevant by the improvement of parentValue calculation proposed earlier
                return inputValue + elementText;
            }
        }

        const getRelevantAttributes = (element: HTMLElement): string => salientAttributes.map(attr => {
            const attrValue = element.getAttribute(attr);
            return attrValue ? `${attr}="${attrValue}"` : "";
        }).filter(Boolean).join(" ")
        //todo ask Boyuan- seems undesirable for an input element's value attribute to be repeated here if it's already in the input value part (from querying the value property)
        // is initializing an input element with a non-empty value attribute common if setting a default value?


        const elementDescWithAttributes = (parentValue + getRelevantAttributes(element)).trim();
        //why do we ignore child attributes if the parent text is defined but the current element doesn't have any
        // relevant attributes? wouldn't it make more sense to include the child attributes in that case?
        if (elementDescWithAttributes) {
            return inputValue + this.removeEolAndCollapseWhitespace(elementDescWithAttributes);
        }

        const childElement = element.firstElementChild;
        if (childElement) {
            const childDescWithAttributes = (parentValue + getRelevantAttributes(childElement as HTMLElement)).trim();
            //if parent_value was non-empty, then wouldn't we have returned before looking at child elements?
            if (childDescWithAttributes) {
                //why would a textarea or input have a child node?
                return inputValue + this.removeEolAndCollapseWhitespace(childDescWithAttributes);
            }
        }

        this.logger.info("ELEMENT DESCRIPTION PROBLEM- unable to create element description for element at xpath " + this.getFullXpath(element));
        return null;
    }

    /**
     * extends library method getXPath to account for shadow DOM's
     * @param element the element whose full xpath should be constructed
     * @returns the full xpath of the given element (from the root of the page's document element)
     */
    getFullXpath = (element: HTMLElement): string => {
        let overallXpath = this.getFullXpathHelper(element);
        const nestedIframesPathToElem = this.fetchAndCacheIframeTree().getIframePathForElement(element);
        if (nestedIframesPathToElem) {
            for (let nestedIframeIdx = nestedIframesPathToElem.length - 1; nestedIframeIdx >= 0; nestedIframeIdx--) {
                const nestedIframeElem = nestedIframesPathToElem[nestedIframeIdx].iframe;
                if (nestedIframeElem) {
                    overallXpath = this.getFullXpathHelper(nestedIframeElem) + overallXpath;
                } else {
                    this.logger.warn("nested iframe element was null in the path to the current element; cannot provide full xpath analysis which takes iframes into account");
                    overallXpath = "/corrupted-node-in-iframe-tree()" + overallXpath;
                }
            }
        }
        return overallXpath;
    }

    private getFullXpathHelper = (element: HTMLElement): string => {
        let xpath = getXPath(element, {ignoreId: true});
        const rootElem = element.getRootNode();
        if (isShadowRoot(rootElem)) {
            xpath = this.getFullXpath(rootElem.host as HTMLElement) + "/shadow-root()" + xpath;
        }
        return xpath;
    }

    /**
     * @description Get data about an element, including its tag name, role/type attributes, bounding box,
     * center coordinates, and a description
     * @param element the element to get data about
     * @return data about the element
     */
    getElementData = (element: HTMLElementWithDocumentHost): ElementData => {
        const tagName = element.tagName.toLowerCase();
        let description = this.getElementDescription(element);
        if (!description) {
            this.logger.trace(`UNABLE TO GENERATE DESCRIPTION FOR ELEMENT; outerHTML: ${element.outerHTML.slice(0, 300)}; parent outerHTML: ${this.getRealParentElement(element)
                ?.outerHTML.slice(0, 300)}`);
            description = "description_unavailable";
            if (tagName === "iframe" && !this.getIframeContent(element as HTMLIFrameElement)) {
                description = "cross_origin_iframe";
            }
        }

        const roleValue = element.getAttribute("role");
        const typeValue = element.getAttribute("type");
        const tagHead = tagName + (roleValue ? ` role="${roleValue}"` : "") + (typeValue ? ` type="${typeValue}"` : "");
        //does it matter that this (& original python code) treat "" as equivalent to null for role and type attributes?

        const boundingRect = this.domHelper.grabClientBoundingRect(element);
        let elemX = boundingRect.x;
        let elemY = boundingRect.y;
        if (element.documentHostChain) {
            //this.logger.debug(`base coords were (${elemX}, ${elemY}) for element with tag head ${tagHead} and description: ${description}`);
            for (const host of element.documentHostChain) {
                const hostBoundingRect = this.domHelper.grabClientBoundingRect(host);
                elemX += hostBoundingRect.x;
                elemY += hostBoundingRect.y;
                //this.logger.debug(`adjusted coords to (${elemX}, ${elemY}) for host element with tag head ${host.tagName} and description: ${this.getElementDescription(host)}`);
            }
            if (element.documentHostChain.length > 1) {
                this.logger.warn(`SURPRISING SCENARIO: _interactive_ element with tag head ${tagHead} and description: ${description} had a document host chain with length ${element.documentHostChain.length}`);
            }
            //otherwise, you get really bizarre behavior where position measurements for 2nd/3rd/etc. annotations on the
            // same page are increasingly wildly off (for elements inside iframes)
            delete element.documentHostChain;
        }

        const centerPoint = [elemX + boundingRect.width / 2, elemY + boundingRect.height / 2] as const;
        const mainDiagCorners =
            {tLx: elemX, tLy: elemY, bRx: elemX + boundingRect.width, bRy: elemY + boundingRect.height};

        return {
            centerCoords: centerPoint, description: description, tagHead: tagHead, boundingBox: mainDiagCorners,
            width: boundingRect.width, height: boundingRect.height, tagName: tagName, element: element,
            xpath: this.getFullXpath(element)
        };
    }


    /**
     * @description Determine whether an element is hidden, based on its CSS properties and the hidden attribute
     * @param element the element which might be hidden
     * @param iframeNode context of the element, if it is inside an iframe
     * @param isDocHostElem whether the element whose visibility is being tested is just a container for another DOM of elements (i.e. shadow root host or iframe element)
     *                          e.g. a container element isn't necessarily expected to be in the foreground (because the interactive elements we care about would typically render on top of it)
     * @param shouldDebug whether to, if the element is hidden, print detailed debugging information about why this element is considered hidden
     * @return true if the element is hidden, false if it is visible
     */
    calcIsHidden = (element: HTMLElement, iframeNode: IframeNode, isDocHostElem: boolean = false,
                    shouldDebug: boolean = false): boolean => {
        const elemComputedStyle = this.domHelper.getComputedStyle(element);
        const elemBoundRect = this.domHelper.grabClientBoundingRect(element);

        let isElemBuried: boolean | undefined = undefined;
        let doesElemSeemInvisible = element.hidden || elemComputedStyle.display === "none"
            || elemComputedStyle.visibility === "hidden";

        if (element.shadowRoot === null) {//only skip this if element is shadow root host, not if it's an iframe element
            doesElemSeemInvisible = doesElemSeemInvisible || elemComputedStyle.height === "0px"
                || elemComputedStyle.width === "0px" || elemBoundRect.width === 0 || elemBoundRect.height === 0;
        }

        if (element.tagName.toLowerCase() !== "input") {
            //1x1 px or 0-opacity elements are generally a css hack to make an element temporarily ~invisible, but
            // sometimes there are weird shenanigans with things like checkbox inputs being 1x1 or completely-transparent
            // but somehow hooked up to a larger clickable span (the span is usually the sibling of the input)
            doesElemSeemInvisible = doesElemSeemInvisible || elemComputedStyle.height === "1px" || elemComputedStyle.width === "1px"
                || elemComputedStyle.opacity === "0";
        }
        if (!doesElemSeemInvisible && !isDocHostElem) {
            //skipping this for elements that are fully outside the viewport
            //todo this performance boost can lead to elements being incorrectly included in weird scenarios:
            // on amazon.com, if a modal dialog is open, grabbing the bounding client rect for an element in the main
            // page (i.e. buried in background behind the dialog) can at least sometimes yield coordinates that are
            // relative to the page origin (rather than the normal behavior of coordinates relative to the viewport);
            // this can lead to the element being incorrectly treated as outside the viewport and thus not being checked
            // for being buried in the background
            if (!this.isFullyOutsideViewport(element, iframeNode)) {
                let backgroundCheckMsg = ``;
                if (shouldDebug) {
                    backgroundCheckMsg = `testing whether element is buried in background: ${this.getFullXpath(element)}; with iframe context ${iframeNode.iframe?.outerHTML.slice(0, 300)}`;
                    this.logger.trace(backgroundCheckMsg);
                }
                isElemBuried = this.isBuriedInBackground(element, iframeNode, shouldDebug);
                if (shouldDebug) { this.logger.trace(`finished ${backgroundCheckMsg}; result was ${isElemBuried}`); }
                doesElemSeemInvisible = isElemBuried;
            } else if (shouldDebug) { this.logger.trace(`skipping 'buried in background' test for element: ${this.getFullXpath(element)}; with iframe context ${iframeNode.iframe?.outerHTML.slice(0, 300)} because it's outside the viewport (and so the check wouldn't work): elem rect: ${JSON.stringify(this.domHelper.grabClientBoundingRect(element))}, iframe context offsets: (${iframeNode.coordsOffsetFromViewport.x}, ${iframeNode.coordsOffsetFromViewport.y}), viewport info: ${JSON.stringify(this.domHelper.getViewportInfo())}`); }
        }

        //if an element is inline and non-childless, its own width and height may not actually be meaningful (since its children
        // can have non-zero width/height and bubble events like clicks up to this element)
        if (doesElemSeemInvisible && elemComputedStyle.display.indexOf("inline") !== -1) {
            for (const child of element.children) {
                if (!this.calcIsHidden(child as HTMLElement, iframeNode, false, shouldDebug)) {
                    this.logger.info(`FOUND A WEIRD ELEMENT ${element.outerHTML.slice(0, 300)}... which itself seemed invisible but which had some kind of 'inline' display status and which had a visible child ${child.outerHTML.slice(0, 300)}...`)
                    doesElemSeemInvisible = false;
                    break;
                }
            }
        }
        //todo consider using new method https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility also

        if (doesElemSeemInvisible && shouldDebug) {
            this.logger.trace(`Element with tag name ${element.tagName} and description: ${this.getElementDescription(element)} was determined to be hidden; is buried in background: ${isElemBuried}; computed style properties: width=${elemComputedStyle.width}, height=${elemComputedStyle.height}, display=${elemComputedStyle.display}, visibility=${elemComputedStyle.visibility}, opacity=${elemComputedStyle.opacity}`);
        }

        return doesElemSeemInvisible;
        //maybe eventually update this once content-visibility is supported outside chromium (i.e. in firefox/safari)
        // https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility

        //if needed, can explore adding logic for other tricks mentioned in this article (e.g. 'clip-path')
        // https://css-tricks.com/comparing-various-ways-to-hide-things-in-css/
    }

    isBuriedInBackground = (element: HTMLElement, iframeNode: IframeNode, shouldDebug: boolean = false): boolean => {
        const boundRect = this.domHelper.grabClientBoundingRect(element);
        if (boundRect.width === 0 || boundRect.height === 0) { return false; }
        //select elements are often partially hidden behind clickable spans and yet are still entirely feasible to interact with through javascript
        // similar problem with checkbox input elements
        const tag = element.tagName.toLowerCase();
        if (tag === "select" || (isInputElement(element) && element.type === "checkbox")) { return false;}

        //todo experiment with whether there are problems from restricting this to solely the center point (There are)
        // maybe make that a toggleable option to boost performance when dealing with elements that behave conveniently
        const queryPoints: [number, number][] = [[boundRect.x + 1, boundRect.y + 1], [boundRect.x + boundRect.width - 1, boundRect.y + 1],
            [boundRect.x + 1, boundRect.y + boundRect.height - 1], [boundRect.x + boundRect.width - 1, boundRect.y + boundRect.height - 1],
            [boundRect.x + boundRect.width / 2, boundRect.y + boundRect.height / 2]
            // , [boundRect.x + boundRect.width / 4, boundRect.y + boundRect.height / 4], [boundRect.x + boundRect.width * 3 / 4, boundRect.y + boundRect.height / 4], [boundRect.x + boundRect.width / 4, boundRect.y + boundRect.height * 3 / 4], [boundRect.x + boundRect.width * 3 / 4, boundRect.y + boundRect.height * 3 / 4]
        ];//can add more query points based on quarters of width and height if we ever encounter a scenario where the existing logic incorrectly dismisses a weirdly-shaped element as being fully background-hidden
        let isBuried = true;
        let searchContext = undefined;//default to using the top-level document
        if (iframeNode.iframe) {
            const iframeContents = this.getIframeContent(iframeNode.iframe);
            if (iframeContents) {
                searchContext = iframeContents;
            } else { this.logger.warn(`Unable to access contents of iframe (${iframeNode.iframe.outerHTML.slice(0, 300)}) that element belongs to (in order to determine whether the element is buried), despite having previously obtained a reference to that element ${element.outerHTML.slice(0, 300)}`); }
        }

        for (let i = 0; i < queryPoints.length && isBuried; i++) {
            const queryPoint = queryPoints[i];
            const foregroundElemAtQueryPoint = this.actualElementFromPoint(queryPoint[0], queryPoint[1], searchContext, shouldDebug, false);
            if (element.contains(foregroundElemAtQueryPoint)) {
                isBuried = false;
            }
        }
        return isBuried;
    }

    hasDisabledProperty(element: any): element is { disabled: boolean } {
        return 'disabled' in element && typeof element.disabled === "boolean";
    }

    hasReadOnlyProperty(element: any): element is { readOnly: boolean } {
        return 'readOnly' in element && typeof element.readOnly === "boolean";
    }

    isFullyOutsideViewport = (element: HTMLElement, iframeNode: IframeNode): boolean => {
        const elemRect = this.domHelper.grabClientBoundingRect(element);
        const elemXRelToViewport = elemRect.x + iframeNode.coordsOffsetFromViewport.x;
        const elemYRelToViewport = elemRect.y + iframeNode.coordsOffsetFromViewport.y;
        const {width, height} = this.domHelper.getViewportInfo();
        return elemXRelToViewport + elemRect.width <= 0 || elemYRelToViewport + elemRect.height <= 0
            || elemXRelToViewport >= width || elemYRelToViewport >= height;
    }

    /**
     * @description Determine whether an element is disabled, based on its attributes and properties
     * @param element the element which might be disabled
     * @return true if the element is disabled, false if it is enabled
     */
    calcIsDisabled = (element: HTMLElement): boolean => {
        return element.ariaDisabled === "true" || (this.hasDisabledProperty(element) && element.disabled)
            || (this.hasReadOnlyProperty(element) && element.readOnly) || element.getAttribute("disabled") != null;
        //todo consider inert? https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert
    }

    /**
     * @description Get interactive elements in the DOM, including links, buttons, inputs, selects, textareas, and elements with certain roles
     * @param excludeElemsOutsideViewport whether to exclude elements which are fully outside the viewport
     * @return data about the interactive elements
     */
    getInteractiveElements = (excludeElemsOutsideViewport: boolean = false): ElementData[] => {
        const interactiveElementSelectors = ['a', 'button', 'input', 'select', 'textarea', 'adc-tab',
            '[role="button"]', '[role="radio"]', '[role="option"]', '[role="combobox"]', '[role="textbox"]',
            '[role="listbox"]', '[role="menu"]', '[role="link"]', '[type="button"]', '[type="radio"]', '[type="combobox"]',
            '[type="textbox"]', '[type="listbox"]', '[type="menu"]', '[tabindex]:not([tabindex="-1"])',
            '[contenteditable]:not([contenteditable="false"])', '[onclick]', '[onfocus]', '[onkeydown]',
            '[onkeypress]', '[onkeyup]', "[checkbox]", '[aria-disabled="false"]', '[data-link]'];

        const elemsFetchStartTs = performance.now();
        //todo somehow want to also grab elements which are scrollable (i.e. they have overflow auto and there're
        // scrollbar(s) on the right and/or bottom sides of the element; that might be too restrictive- look for scrollHeight > clientHeight)
        const uniqueInteractiveElements = this.enhancedQuerySelectorAll(interactiveElementSelectors,
            (elem, iframeNode) => !(this.calcIsDisabled(elem) || (excludeElemsOutsideViewport && this.isFullyOutsideViewport(elem, iframeNode))), true);
        const elemFetchDuration = performance.now() - elemsFetchStartTs;//ms
        //todo move this threshold to 250 or 500 ms after there's time to investigate/remediate the recent jump in fetch time
        // this isn't a perf bottleneck in agent use case, but it is in the action annotation/data-collection use case
        (elemFetchDuration < 500 ? this.logger.debug : this.logger.info)(`time to fetch interactive elements: ${elemFetchDuration.toFixed(5)} ms`);

        const interactiveElementsData = uniqueInteractiveElements.map((element, index) => {
            const elementData = this.getElementData(element);
            elementData.interactivesIndex = index;
            return elementData;
        })
        //todo consider filtering based on elements having excessively high overlap % in their bounding boxes, at which
        // point this should pick one using this.judgeOverlappingElementsForForeground()
        // can reuse some logic from PageDataCollector.sortBestTargetElemFirst()

        return interactiveElementsData;
    }

    highlightElement = async (element: HTMLElement, allInteractiveElements: ElementData[] = [], highlightDuration: number = 30000): Promise<HTMLElement|undefined> => {
        return this.elementHighlighter.highlightElement(element, allInteractiveElements, highlightDuration);
    }

    clearElementHighlightingEarly = async () => {
        await this.elementHighlighter.clearElementHighlightingEarly();
    }


    /**
     * safely access contents of an iframe and record any cases where the iframe content is inaccessible
     * @param iframe an iframe whose contents should be accessed
     * @returns the root document of the iframe's contents, or null if the iframe's content is inaccessible
     */
    getIframeContent = (iframe: HTMLIFrameElement): Document | null => {
        try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document || null;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- guarantees that SecurityError will be thrown if it's cross-origin
            const iframeHtml = iframeDoc?.documentElement.outerHTML;
            return iframeDoc;
        } catch (error: any) {
            if (error.name === "SecurityError") {
                this.logger.debug(`Cross-origin (${iframe.src}) iframe detected while grabbing iframe content: ${
                    renderUnknownValue(error).slice(0, 100)}`);
            } else {
                this.logger.error(`Error grabbing iframe content: ${renderUnknownValue(error)}`);
            }
            return null;
        }
    }

    /**
     * find matching elements even inside of shadow DOM's or (some) iframes
     * Can search for multiple css selectors (to avoid duplicating the effort of finding/traversing the various shadow DOM's and iframes)
     *
     * partly based on this https://stackoverflow.com/a/71692555/10808625 (for piercing shadow DOM's), plus additional
     * logic to handle iframes, multiple selectors, etc.
     * Avoids duplicates within a given scope (from multiple selectors matching an element), but doesn't currently have
     * protection against duplicates across different scopes (since intuitively it shouldn't be possible for an element
     * to be in both a shadow DOM and the main document)
     * @param cssSelectors The CSS selectors to use to find elements
     * @param elemFilter predicate to immediately eliminate irrelevant elements before they slow down the
     *                      array-combining operations
     * @param shouldIgnoreHidden whether to ignore hidden/not-displayed elements
     * @returns array of elements that match any of the CSS selectors;
     *          this is a static view of the elements (not live access that would allow modification)
     */
    enhancedQuerySelectorAll = (cssSelectors: string[],
                                elemFilter: (elem: HTMLElement, iframeNode: IframeNode) => boolean, shouldIgnoreHidden: boolean = true
    ): Array<HTMLElementWithDocumentHost> => {
        const topWindow = this.domHelper.window as Window;
        if (this.cachedShadowRootHostChildrenOfMainDoc === undefined) {this.cachedShadowRootHostChildrenOfMainDoc = this.initializeCacheOfShadowRootHostChildrenOfMainDoc();}

        //todo measure which operations in this recursive stack are taking up the most time in total
        // I suspect the elementFromPoint() calls, since fetch time seemed to have shot up recently from 10-20ms to 60-130ms
        // Since this is single-threaded, can use instance vars to accumulate time spent on different things
        //  (as long as those instance vars are reset at the start of each call of this method)
        return this.enhancedQuerySelectorAllHelper(cssSelectors, topWindow.document, this.fetchAndCacheIframeTree().root,
            elemFilter, this.cachedShadowRootHostChildrenOfMainDoc, shouldIgnoreHidden);
    }

    enhancedQuerySelectorAllHelper = (cssSelectors: string[], root: ShadowRoot | Document, iframeContextNode: IframeNode,
                                      elemFilter: (elem: HTMLElement, iframeNode: IframeNode) => boolean,
                                      cachedShadowRootHostChildren?: HTMLElement[], shouldIgnoreHidden: boolean = true
    ): Array<HTMLElementWithDocumentHost> => {
        let callIdentifier = '';
        if (iframeContextNode.iframe) {
            callIdentifier = `iframe with src ${iframeContextNode.iframe.src} and iframe path ${this.getFullXpath(iframeContextNode.iframe)}`;
        }
        if (isShadowRoot(root)) {
            if (callIdentifier.length !== 0) { callIdentifier += "; within that, "; }
            callIdentifier += `shadow root of host element with xpath ${this.getFullXpath(root.host as HTMLElement)}`;
        }
        if (callIdentifier.length === 0) { callIdentifier = "top-level document"; }

        this.logger.trace(`Starting enhancedQuerySelectorAllHelper call within context: ${callIdentifier}`);
        let possibleShadowRootHosts = cachedShadowRootHostChildren ?? this.domHelper.fetchElementsByCss('*', root);
        if (shouldIgnoreHidden) { possibleShadowRootHosts = possibleShadowRootHosts.filter(elem => !this.calcIsHidden(elem, iframeContextNode, true)); }
        let shadowRootsOfChildren = possibleShadowRootHosts.map(elem => elem.shadowRoot) as ShadowRoot[];
        if (!cachedShadowRootHostChildren) { shadowRootsOfChildren = shadowRootsOfChildren.filter(Boolean);}

        const iframeNodes = iframeContextNode.children;
        //+1 is for the current scope results array, in case none of the child iframes get disqualified for being hidden
        const resultArrays: HTMLElement[][] = new Array<Array<HTMLElement>>(shadowRootsOfChildren.length + iframeNodes.length + 1);

        this.logger.trace(`Starting recursive calls into up to ${iframeNodes.length} iframes within context: ${callIdentifier}`);
        for (const childIframeNode of iframeNodes) {
            const childIframeElem = childIframeNode.iframe;
            if (!childIframeElem) {
                this.logger.warn("iframeNode had null iframe element, so skipping it");
                continue;
            }
            if (shouldIgnoreHidden && this.calcIsHidden(childIframeElem, iframeContextNode, true)) {
                this.logger.trace(`Ignoring hidden iframe element ${childIframeElem.outerHTML.slice(0, 300)}`);
                continue;
            }

            const iframeContent = this.getIframeContent(childIframeElem);
            if (iframeContent) {
                const resultsForIframe = this.enhancedQuerySelectorAllHelper(cssSelectors, iframeContent, childIframeNode, elemFilter, undefined, shouldIgnoreHidden);
                resultsForIframe.forEach(elem => {
                    if (elem.documentHostChain === undefined) {elem.documentHostChain = [];}
                    elem.documentHostChain.push(childIframeElem);
                });
                resultArrays.push(resultsForIframe);
            }
        }

        this.logger.trace(`Finished recursive calls into iframes and starting recursive calls into ${shadowRootsOfChildren.length} shadow roots within context: ${callIdentifier}`);
        shadowRootsOfChildren.map(childShadowRoot => this.enhancedQuerySelectorAllHelper(cssSelectors, childShadowRoot, iframeContextNode, elemFilter, undefined, shouldIgnoreHidden))
            .forEach(resultsForShadowRoot => resultArrays.push(resultsForShadowRoot));
        this.logger.trace(`Finished recursive calls into shadow roots and starting search for regular elements within context: ${callIdentifier}`);

        //based on https://developer.mozilla.org/en-US/docs/Web/API/Node/isSameNode, I'm pretty confident that simple
        // element === element checks by the Set class will prevent duplicates
        const currScopeResults: Set<HTMLElement> = new Set();
        cssSelectors.forEach(selector => this.domHelper.fetchElementsByCss(selector, root).filter(elem => elemFilter(elem, iframeContextNode))
            .forEach(elem => {
                if (!shouldIgnoreHidden || !this.calcIsHidden(elem, iframeContextNode)) {
                    currScopeResults.add(elem);
                } else {this.logger.trace(`Ignoring hidden element ${elem.outerHTML.slice(0, 300)} that was found with css selector ${selector}`);}
            }));
        const clickableElementsBasedOnProperty = this.domHelper.fetchElementsByCss('*', root)
            .filter(elem => Boolean(elem.onclick)).filter(elem => elemFilter(elem, iframeContextNode));
        if (clickableElementsBasedOnProperty.length > 0) { this.logger.debug(`Found ${clickableElementsBasedOnProperty.length} CLICKABLE ELEMENTS BASED ON THE ONCLICK PROPERTY within context: ${callIdentifier}`); }
        clickableElementsBasedOnProperty.forEach(elem => {
            if (!shouldIgnoreHidden || !this.calcIsHidden(elem, iframeContextNode)) {
                currScopeResults.add(elem);
            } else {this.logger.trace(`Ignoring hidden element ${elem.outerHTML.slice(0, 300)} that was found because it had the onclick property defined`);}
        });
        //it would be far more complex to detect elements that are clickable only because a handler was attached to them
        // with `addEventListener('click', ...)`; that would require complex and potentially very slow code that
        // collaborated with the service worker to find all elements with event listeners attached to them using
        // chrome.debugger and then figuring out which ones were for click events; that would be even more complicated
        // if this helper was being called for an iframe's document (the chrome.debugger.attach() call couldn't simply
        // target the tabId but would need to do weird things https://developer.chrome.com/docs/extensions/reference/api/debugger#work_with_frames )


        //todo search for scrollable elements and add them to the results
        // https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollHeight
        // then need to modify getElementData to check for whether the element is scrollable and if so add a flag (and possibly more details like scrollHeight relative to client height and offsetTop/(scrollHeight-clientHeight)

        resultArrays.push(Array.from(currScopeResults));

        //todo consider implementing custom array merging logic instead of HTML[][].flat() if this method is proving to be a noticeable performance bottleneck even sometimes
        // e.g. look at this source: https://dev.to/uilicious/javascript-array-push-is-945x-faster-than-array-concat-1oki
        const htmlElements = resultArrays.flat();
        this.logger.trace(`Finished search for regular elements and returning combined results (${htmlElements.length} elements) within context: ${callIdentifier}`);
        return htmlElements;
    }


    /**
     * this tries to tunnel through shadow roots and iframes to find the actual active/focused element
     * It also automatically deals with the annoying browser behavior of sometimes returning the `<body>` element
     * as a default value for document.activeElement
     * Finally, it checks for the active element not being visible and logs a warning if so
     */
    findRealActiveElement = (): HTMLElement | null => {
        const activeElem = this.getRealActiveElementInContext(this.domHelper.dom);
        if (activeElem) {
            if (activeElem.tagName.toLowerCase() === "body") {
                return null;
            }
            if (this.calcIsHidden(activeElem, new IframeNode(null, this.domHelper.window as Window), false, true)
            ) {this.logger.warn(`Active element is hidden, so it's likely not the intended target: ${activeElem.outerHTML.slice(0, 300)}`);}
        }
        return activeElem;
    }

    private getRealActiveElementInContext(root: Document | ShadowRoot): HTMLElement | null {
        let actualActiveElement: HTMLElement | null = null;
        const currContextActiveElement = root.activeElement as HTMLElement;
        if (currContextActiveElement) {
            if (currContextActiveElement.shadowRoot) {
                actualActiveElement = this.getRealActiveElementInContext(currContextActiveElement.shadowRoot);
            } else if (isIframeElement(currContextActiveElement)) {
                const iframeContent = this.getIframeContent(currContextActiveElement);
                if (iframeContent) {
                    actualActiveElement = this.getRealActiveElementInContext(iframeContent);
                }
            } else {
                actualActiveElement = currContextActiveElement;
            }
        }
        return actualActiveElement;
    }

    setupMouseMovementTracking = (positionUpdater: (x: number, y: number) => void) => {
        this.setupMouseMovementTrackingHelper(this.fetchAndCacheIframeTree().root, positionUpdater);
    }

    setupMouseMovementTrackingHelper = (iframeContextNode: IframeNode, positionUpdater: (x: number, y: number) => void) => {
        let currContextDocument: Document | null = null;
        try {
            currContextDocument = iframeContextNode.window.document;
        } catch (error: any) {
            if (error.name === "SecurityError") {
                this.logger.debug(`Cross-origin (${iframeContextNode.iframe?.src}) iframe detected while adding mouse movement listeners for nested documents: ${
                    renderUnknownValue(error).slice(0, 100)}`);
            } else {
                this.logger.error(`Error while adding mouse movement listeners for nested documents: ${renderUnknownValue(error)}`);
            }
        }
        if (currContextDocument) {
            const existingMovementHandler = this.existingMouseMovementListeners.get(currContextDocument);
            if (existingMovementHandler) {
                currContextDocument.removeEventListener('mousemove', existingMovementHandler);
                this.existingMouseMovementListeners.delete(currContextDocument);
            }

            const newMovementHandler = (e: MouseEvent) => {
                //this.logger.trace(`Mouse moved to (${e.clientX}, ${e.clientY}) in iframe context which has offset-from-viewport of ${JSON.stringify(iframeContextNode.coordsOffsetFromViewport)} and iframe outerhtml ${iframeContextNode.iframe?.outerHTML.slice(0, 300)}`);
                positionUpdater(e.clientX + iframeContextNode.coordsOffsetFromViewport.x, e.clientY + iframeContextNode.coordsOffsetFromViewport.y);
            };
            currContextDocument.addEventListener('mousemove', newMovementHandler);
            this.existingMouseMovementListeners.set(currContextDocument, newMovementHandler);
        }
        for (const childIframe of iframeContextNode.children) {
            this.setupMouseMovementTrackingHelper(childIframe, positionUpdater);
        }
    }

    terminateMouseMovementTracking = () => {
        this.existingMouseMovementListeners.forEach((movementHandler, doc) => {
            doc.removeEventListener('mousemove', movementHandler);
        });
        this.existingMouseMovementListeners.clear();
    }

    findQueryPointsInOverlap = (elem1Data: ElementData, elem2Data: ElementData): Array<readonly [number, number]> => {
        const overlapLeftX = Math.max(elem1Data.boundingBox.tLx, elem2Data.boundingBox.tLx);
        const overlapRightX = Math.min(elem1Data.boundingBox.bRx, elem2Data.boundingBox.bRx);
        const overlapTopY = Math.max(elem1Data.boundingBox.tLy, elem2Data.boundingBox.tLy);
        const overlapBottomY = Math.min(elem1Data.boundingBox.bRy, elem2Data.boundingBox.bRy);
        const queryPoints: Array<readonly [number, number]> = [];
        if (overlapLeftX >= overlapRightX || overlapTopY >= overlapBottomY) {
            this.logger.debug(`No overlap between elements ${elem1Data.description} and ${elem2Data.description}`);
            return queryPoints;
        }
        queryPoints.push([overlapLeftX + 1, overlapTopY + 1], [overlapRightX - 1, overlapTopY + 1],
            [overlapLeftX + 1, overlapBottomY - 1], [overlapRightX - 1, overlapBottomY - 1]);
        if (elem1Data.centerCoords[0] >= overlapLeftX && elem1Data.centerCoords[0] <= overlapRightX &&
            elem1Data.centerCoords[1] >= overlapTopY && elem1Data.centerCoords[1] <= overlapBottomY
        ) {queryPoints.push(elem1Data.centerCoords);}
        if (elem2Data.centerCoords[0] >= overlapLeftX && elem2Data.centerCoords[0] <= overlapRightX &&
            elem2Data.centerCoords[1] >= overlapTopY && elem2Data.centerCoords[1] <= overlapBottomY
        ) {queryPoints.push(elem2Data.centerCoords);}

        return queryPoints;
    }

    actualElementFromPoint(x: number, y: number, searchDom?: Document | ShadowRoot, shouldDebug = false, isElemExpectedAtPoint = true): HTMLElement | null {
        const {width, height} = this.domHelper.getViewportInfo();
        if (x < 0 || y < 0 || x >= width || y >= height) {
            this.logger.trace(`Attempted to find element at point ${x}, ${y} which is outside the viewport`);
            return null;
        }
        let foremostElemAtPoint: HTMLElement | null = null;
        //for some reason, at least sometimes (e.g. BritishAirways.com Find Flights button), elementsFromPoint()[0] will actually
        // return the real element at the point (the one inside the shadow DOM), while elementFromPoint() will return the shadow host, even when called on that shadow host's shadowRoot!
        // even though those two expressions should theoretically always be equivalent when there's an element at that point at all
        const elemsAtPoint = this.domHelper.elementsFromPoint(x, y, searchDom);
        if (shouldDebug) {
            this.logger.debug(`Found ${elemsAtPoint.length} elements at point ${x}, ${y}; searchDom: ${searchDom ? searchDom.nodeName : "undefined"}`);
            elemsAtPoint.forEach((elem, idx) => this.logger.debug(`${idx}th element at point: ${elem.outerHTML.slice(0, 300)}`));
            this.logger.debug(`elementFromPoint result: ${this.domHelper.elementFromPoint(x, y, searchDom)?.outerHTML
                .slice(0, 300)}`);
        }

        const searchContextHost: Element | null = isShadowRoot(searchDom) ? searchDom.host : null;
        for (const elem of elemsAtPoint) {
            if (isHtmlElement(elem)) {
                if (searchContextHost === elem) {
                    this.logger.trace(`FOUND THE SHADOW HOST ELEMENT AT THE POINT ${x}, ${y} when searching within that host element's shadow DOM; giving up on further digging into shadow DOM's to avoid risk of infinite recursion: ${elem.outerHTML.slice(0, 200)}`);
                    break;
                } else {
                    foremostElemAtPoint = elem;
                    break;
                }
            } else { this.logger.info(`found a non htmlelement element at the point ${x}, ${y}; skipping it: ${elem.outerHTML.slice(0, 200)}`); }
        }

        if (!foremostElemAtPoint) {
            this.logger.trace(`${maybeUpperCase("no element found at point", isElemExpectedAtPoint)} ${x}, ${y}; checking${searchDom ? " relative to a surrounding context" : ""} for shadow roots that overlap that point`);
            //deal with shadow root possibility
            let currScopeShadowRootHostAtMousePos = undefined;
            if (searchDom === undefined) {
                if (this.cachedShadowRootHostChildrenOfMainDoc === undefined) {this.cachedShadowRootHostChildrenOfMainDoc = this.initializeCacheOfShadowRootHostChildrenOfMainDoc();}
                currScopeShadowRootHostAtMousePos = this.findShadowRootHostAtPos(x, y, this.cachedShadowRootHostChildrenOfMainDoc);
            } else {
                const childrenOfCurrShadowRootWhichHostShadowRoots = this.domHelper.fetchElementsByCss('*', searchDom)
                    .filter(elem => elem.shadowRoot !== null);
                currScopeShadowRootHostAtMousePos = this.findShadowRootHostAtPos(x, y, childrenOfCurrShadowRootWhichHostShadowRoots);
            }
            if (currScopeShadowRootHostAtMousePos && currScopeShadowRootHostAtMousePos.shadowRoot) {
                this.logger.trace(`RECURSING INTO SHADOW DOM to find element at position ${x}, ${y}`);
                foremostElemAtPoint = this.actualElementFromPoint(x, y, currScopeShadowRootHostAtMousePos.shadowRoot);
            }
        } else if (isIframeElement(foremostElemAtPoint)) {
            this.logger.trace(`going to try to recurse into iframe to find element at position ${x}, ${y}`);
            const iframeNode = this.fetchAndCacheIframeTree().findIframeNodeForIframeElement(foremostElemAtPoint);
            if (iframeNode) {
                const iframeContent = this.getIframeContent(foremostElemAtPoint);
                if (iframeContent) {
                    this.logger.trace(`RECURSING INTO IFRAME to find element at position ${x}, ${y} with offsets ${iframeNode.coordsOffsetFromViewport.x}, ${iframeNode.coordsOffsetFromViewport.y}`);
                    foremostElemAtPoint = this.actualElementFromPoint(x - iframeNode.coordsOffsetFromViewport.x, y - iframeNode.coordsOffsetFromViewport.y, iframeContent);
                } else {this.logger.info("unable to access iframe content, so unable to access the actual element at point which takes iframes into account");}
            } else {this.logger.info("unable to find iframe node for iframe element, so unable to access the actual element at point which takes iframes into account");}
        } else if (foremostElemAtPoint.shadowRoot) {
            this.logger.trace(`RECURSING INTO SHADOW DOM to find element at position ${x}, ${y}, from host element at that point ${foremostElemAtPoint.outerHTML.slice(0, 200)}`);
            if (foremostElemAtPoint.shadowRoot !== searchDom) {
                foremostElemAtPoint = this.actualElementFromPoint(x, y, foremostElemAtPoint.shadowRoot);
            } else { this.logger.warn(`when searching for element at point ${x}, ${y} within a shadow root hosted by an element, the resulting element was the same as the host of the shadow root/DOM! aborting further recursion to avoid stack overflow; host element details: ${foremostElemAtPoint.outerHTML.slice(0, 200)}`); }
        }
        return foremostElemAtPoint;
    }

    /**
     * @description Determine which of two elements is in the foreground, based on checking various points in their area of overlap
     * @param elem1Data info about the first element to compare
     * @param elem2Data info about the second element to compare
     * @return 0 if they have no overlap, if neither is in foreground at any point in the overlap region, or if they each have an equal number of points where they are in the foreground;
     *         1 if elem1 is in the foreground at more points in the overlap region than elem2 (but elem2 is in foreground at 1 point at least);
     *         2 if elem1 is in the foreground at any points in the overlap region and elem2 is in the foreground at 0 points
     *         -1 if elem2 is in the foreground at more points in the overlap region than elem1 (but elem1 is in foreground at 1 point at least);
     *         -2 if elem2 is in the foreground at any points in the overlap region and elem1 is in the foreground at 0 points
     */
    judgeOverlappingElementsForForeground = (elem1Data: ElementData, elem2Data: ElementData): -2 | -1 | 0 | 1 | 2 => {
        const queryPoints = this.findQueryPointsInOverlap(elem1Data, elem2Data);
        if (queryPoints.length === 0) {return 0;}
        let numPointsWhereElem1IsForeground = 0;
        let numPointsWhereElem2IsForeground = 0;
        for (const queryPoint of queryPoints) {
            const foregroundElemAtQueryPoint = this.actualElementFromPoint(queryPoint[0], queryPoint[1]);
            //this.logger.debug(`Element at point ${queryPoint[0]}, ${queryPoint[1]}: ${foregroundElemAtQueryPoint?.outerHTML.slice(0, 200)}; `);
            const inElem1 = elem1Data.element.contains(foregroundElemAtQueryPoint);
            const inElem2 = elem2Data.element.contains(foregroundElemAtQueryPoint);
            if (inElem1 && !inElem2) {
                numPointsWhereElem1IsForeground++;
            } else if (inElem2 && !inElem1) {
                numPointsWhereElem2IsForeground++;
            } else if (inElem1 && inElem2) {
                if (elem1Data.element === foregroundElemAtQueryPoint) {
                    numPointsWhereElem1IsForeground++;
                } else if (elem2Data.element === foregroundElemAtQueryPoint) {
                    numPointsWhereElem2IsForeground++;
                } else {
                    this.logger.debug(`Element at point ${queryPoint[0]}, ${queryPoint[1]} was in both ${elem1Data.description} and ${elem2Data.description} but not equal to either, relying on heuristic that the closer ancestor of the foreground element is closer to the foreground in the UI`);
                    if (elem1Data.element.contains(elem2Data.element)) {
                        numPointsWhereElem2IsForeground++;
                    } else { numPointsWhereElem1IsForeground++; }
                }
            } else { this.logger.info(`neither of the overlapping elements ${elem1Data.description} and ${elem2Data.description} contained the foreground element ${foregroundElemAtQueryPoint?.outerHTML.slice(0, 200)} at position ${queryPoint[0]}, ${queryPoint[1]} in their overlap region`)}
        }
        if (numPointsWhereElem1IsForeground === 0) {this.logger.info(`No query points where ${elem1Data.description} was in the foreground, when evaluating its overlap with ${elem2Data.description}`);}
        if (numPointsWhereElem2IsForeground === 0) {this.logger.info(`No query points where ${elem2Data.description} was in the foreground, when evaluating its overlap with ${elem1Data.description}`);}
        let comparisonVal: -2 | -1 | 0 | 2 | 1 = 0;
        if (numPointsWhereElem1IsForeground > numPointsWhereElem2IsForeground) {
            comparisonVal = numPointsWhereElem2IsForeground === 0 ? 2 : 1;
        } else if (numPointsWhereElem1IsForeground < numPointsWhereElem2IsForeground
        ) {comparisonVal = numPointsWhereElem1IsForeground === 0 ? -2 : -1;}
        return comparisonVal;
    }

    /**
     * works even when the given element is at the top of a shadow DOM or an iframe's document
     * @param element element whose parent should be retrieved
     */
    getRealParentElement = (element: HTMLElement): HTMLElement | null => {
        let parentElement: HTMLElement | null = null;
        if (isShadowRoot(element.parentNode)) {
            const hostElem = element.parentNode.host;
            if (isHtmlElement(hostElem)) {
                parentElement = hostElem;
            } else { this.logger.info(`ELEMENT HAD SHADOW ROOT PARENT WITH ${hostElem === null ? "null host" : "non-HTMLElement host"}; element text: ${element.outerHTML.slice(0, 300)}`); }
        } else if (isDocument(element.parentNode) && element.parentNode.defaultView?.frameElement) {
            const frameElem = element.parentNode.defaultView.frameElement;
            if (isHtmlElement(frameElem)) {
                parentElement = frameElem;
            } else { this.logger.info(`ELEMENT AT TOP OF SECONDARY DOCUMENT HAD ${frameElem === null ? "null frame" : "non-HTMLElement frame"} element as the host/frame for that secondary document; element text: ${element.outerHTML.slice(0, 300)}`); }
        } else {
            parentElement = element.parentElement;
        }
        return parentElement;
    }

    findShadowRootHostAtPos = (xPos: number, yPos: number, shadowRootHostChildren: HTMLElement[]): HTMLElement | undefined => {
        this.logger.trace(`finding host of shadow root at position ${xPos}, ${yPos} out of ${shadowRootHostChildren.length} options`);
        let shadowRootHostAtPos = undefined;

        const relevantShadowRootHosts = shadowRootHostChildren.filter(elem => {
            const hostBoundRect = this.domHelper.grabClientBoundingRect(elem);
            return xPos >= hostBoundRect.x && xPos <= hostBoundRect.x + hostBoundRect.width &&
                yPos >= hostBoundRect.y && yPos <= hostBoundRect.y + hostBoundRect.height;
        });
        if (relevantShadowRootHosts.length > 0) {
            if (relevantShadowRootHosts.length > 1) {
                this.logger.warn(`Multiple shadow host elements (${relevantShadowRootHosts.length}) were found to contain the point ${xPos}, ${yPos}; only the first one will be considered`);
            }
            shadowRootHostAtPos = relevantShadowRootHosts[0];
            const shadowRoot = relevantShadowRootHosts[0].shadowRoot;
            if (!shadowRoot) {this.logger.warn(`shadow host element at position ${xPos}, ${yPos} had null shadow root`);}
        } else {
            this.logger.info(`no overlapping shadow root host found at point ${xPos}, ${yPos}`);
        }
        return shadowRootHostAtPos;
    }

}